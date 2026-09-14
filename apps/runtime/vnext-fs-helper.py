#!/usr/bin/python3
import base64
import fcntl
import hashlib
import json
import os
import secrets
import stat
import sys

O_NOFOLLOW_ANY = 0x20000000
F_GETPATH = 50
PATH_BUFFER_BYTES = 1024
MAX_INLINE_BYTES = 1024 * 1024
MAX_WRITE_BYTES = 8 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


def fail(message):
    sys.stderr.write(json.dumps({'error': message}) + '\n')
    raise SystemExit(2)


def output(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')


def validated_relative(root, target):
    if not os.path.isabs(root) or not os.path.isabs(target):
        fail('workspace root and target must be absolute')
    root = os.path.normpath(root)
    target = os.path.normpath(target)
    if os.path.realpath(root) != root:
        fail('workspace root is not a stable physical directory')
    relative = os.path.relpath(target, root)
    if relative in ('.', '..') or os.path.isabs(relative) or relative.startswith('..' + os.sep):
        fail('target escapes workspace root or names the workspace root')
    parts = relative.split(os.sep)
    if not parts or any(part in ('', '.', '..') for part in parts):
        fail('target path is invalid')
    return root, parts


def open_parent(root, parts):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | O_NOFOLLOW_ANY
    root_fd = os.open(root, flags)
    current_fd = root_fd
    try:
        for component in parts[:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=current_fd)
            metadata = os.fstat(next_fd)
            if not stat.S_ISDIR(metadata.st_mode):
                os.close(next_fd)
                fail('parent component is not a physical directory')
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = next_fd
        return root_fd, current_fd, parts[-1]
    except BaseException:
        if current_fd != root_fd:
            os.close(current_fd)
        os.close(root_fd)
        raise


def descriptor_path(file_fd):
    try:
        raw = fcntl.fcntl(file_fd, F_GETPATH, b'\0' * PATH_BUFFER_BYTES)
    except OSError:
        fail('target pathname identity is unavailable')
    return os.path.normpath(os.fsdecode(raw.split(b'\0', 1)[0]))


def open_verified_file(root, target):
    root, parts = validated_relative(root, target)
    expected_target = os.path.join(root, *parts)
    root_fd, parent_fd, name = open_parent(root, parts)
    file_fd = None
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent_fd)
        metadata = os.fstat(file_fd)
        if descriptor_path(file_fd) != expected_target:
            fail('target pathname no longer identifies the workspace entry')
        if not stat.S_ISREG(metadata.st_mode):
            fail('target is not a regular file')
        if metadata.st_nlink != 1:
            fail('hard-linked files are outside the safe workspace content model')
        return root_fd, parent_fd, name, file_fd, metadata, expected_target
    except BaseException:
        if file_fd is not None:
            os.close(file_fd)
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)
        raise


def close_verified(root_fd, parent_fd, file_fd):
    if file_fd is not None:
        os.close(file_fd)
    if parent_fd != root_fd:
        os.close(parent_fd)
    os.close(root_fd)


def revalidate_entry(parent_fd, name, file_fd, original, expected_target):
    after = os.fstat(file_fd)
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        fail('workspace target disappeared during execution')
    if (after.st_nlink != 1
            or after.st_dev != original.st_dev
            or after.st_ino != original.st_ino
            or not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
            or current.st_dev != original.st_dev
            or current.st_ino != original.st_ino
            or descriptor_path(file_fd) != expected_target):
        fail('workspace target identity changed during execution')


def stream_hash(file_fd):
    digest = hashlib.sha256()
    os.lseek(file_fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(file_fd, CHUNK_BYTES)
        if not chunk:
            break
        digest.update(chunk)
    return digest.hexdigest()


def hash_file(root, target):
    root_fd, parent_fd, name, file_fd, metadata, expected_target = open_verified_file(root, target)
    try:
        digest = stream_hash(file_fd)
        revalidate_entry(parent_fd, name, file_fd, metadata, expected_target)
        output({'sha256': digest, 'size': metadata.st_size})
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        close_verified(root_fd, parent_fd, file_fd)


def read_text(root, target, max_bytes_text, encoding):
    try:
        max_bytes = int(max_bytes_text)
    except ValueError:
        fail('maxBytes is invalid')
    if max_bytes <= 0 or max_bytes > MAX_INLINE_BYTES:
        fail('maxBytes exceeds the bounded text-read limit')
    if encoding.lower() != 'utf-8':
        fail('only UTF-8 text reads are supported in Phase 2')
    root_fd, parent_fd, name, file_fd, metadata, expected_target = open_verified_file(root, target)
    try:
        if metadata.st_size > max_bytes:
            fail('text target exceeds maxBytes')
        chunks = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b''.join(chunks)
        if len(payload) > max_bytes:
            fail('text target exceeds maxBytes')
        try:
            text = payload.decode('utf-8', errors='strict')
        except UnicodeDecodeError:
            fail('text target is not valid UTF-8')
        disallowed = sum(1 for character in text if ord(character) < 32 and character not in ('\n', '\r', '\t'))
        if '\x00' in text or (len(text) > 0 and disallowed * 100 > len(text) * 2):
            fail('text target appears binary; refusing lossy/binary decoding')
        revalidate_entry(parent_fd, name, file_fd, metadata, expected_target)
        output({'text': text, 'bytes': len(payload), 'encoding': 'utf-8'})
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        close_verified(root_fd, parent_fd, file_fd)


def read_range(root, target, offset_text, length_text):
    try:
        offset = int(offset_text)
        length = int(length_text)
    except ValueError:
        fail('byte range is invalid')
    if offset < 0 or length <= 0 or length > MAX_INLINE_BYTES:
        fail('byte range exceeds Phase 2 bounds')
    root_fd, parent_fd, name, file_fd, metadata, expected_target = open_verified_file(root, target)
    try:
        if offset > metadata.st_size:
            fail('byte range offset exceeds file size')
        payload = os.pread(file_fd, length, offset)
        revalidate_entry(parent_fd, name, file_fd, metadata, expected_target)
        output({
            'base64': base64.b64encode(payload).decode('ascii'),
            'offset': offset,
            'bytes': len(payload),
            'fileSize': metadata.st_size,
            'eof': offset + len(payload) >= metadata.st_size,
        })
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        close_verified(root_fd, parent_fd, file_fd)


def read_payload():
    payload = sys.stdin.buffer.read(MAX_WRITE_BYTES + 1)
    if len(payload) > MAX_WRITE_BYTES:
        fail('write payload exceeds Phase 2 bounded write size')
    return payload


def write_all(file_fd, payload, failure_message):
    written = 0
    while written < len(payload):
        count = os.write(file_fd, payload[written:])
        if count <= 0:
            fail(failure_message)
        written += count


def write_temp(parent_fd, prefix, payload):
    temp_name = f'.{prefix}-{os.getpid()}-{secrets.token_hex(16)}'
    temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
    try:
        write_all(temp_fd, payload, 'write payload could not be completed')
        os.fsync(temp_fd)
        metadata = os.fstat(temp_fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail('temporary workspace write lost isolated regular-file identity')
        return temp_name, temp_fd
    except BaseException:
        os.close(temp_fd)
        try:
            os.unlink(temp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        raise


def write_create(root, target):
    payload = read_payload()
    root, parts = validated_relative(root, target)
    root_fd, parent_fd, name = open_parent(root, parts)
    temp_name = None
    temp_fd = None
    try:
        try:
            os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            fail('create target already exists')
        except FileNotFoundError:
            pass
        temp_name, temp_fd = write_temp(parent_fd, 'iris-create', payload)
        try:
            os.link(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        except FileExistsError:
            fail('create target appeared during execution')
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISREG(current.st_mode) or current.st_nlink != 2:
            fail('created target did not retain expected physical identity')
        os.unlink(temp_name, dir_fd=parent_fd)
        temp_name = None
        final = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISREG(final.st_mode) or final.st_nlink != 1:
            fail('created target did not settle as one physical regular file')
        os.fsync(parent_fd)
        output({'bytes': len(payload), 'mode': 'CREATE'})
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


def existing_regular(parent_fd, name):
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        fail('replace/append target does not exist')
    if not stat.S_ISREG(metadata.st_mode):
        fail('replace/append target is not a regular file')
    if metadata.st_nlink != 1:
        fail('hard-linked files are outside the safe workspace write model')
    return metadata


def same_entry(current, expected):
    return stat.S_ISREG(current.st_mode) and current.st_nlink == 1 and current.st_dev == expected.st_dev and current.st_ino == expected.st_ino


def write_replace(root, target):
    payload = read_payload()
    root, parts = validated_relative(root, target)
    root_fd, parent_fd, name = open_parent(root, parts)
    temp_name = None
    temp_fd = None
    try:
        existing = existing_regular(parent_fd, name)
        temp_name, temp_fd = write_temp(parent_fd, 'iris-replace', payload)
        current = existing_regular(parent_fd, name)
        if not same_entry(current, existing):
            fail('replace target identity changed during execution')
        os.rename(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temp_name = None
        os.fsync(parent_fd)
        output({'bytes': len(payload), 'mode': 'REPLACE'})
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


def append_file(root, target, expected_size_text, expected_sha):
    payload = read_payload()
    try:
        expected_size = int(expected_size_text)
    except ValueError:
        fail('expectedSize is invalid')
    if expected_size < 0:
        fail('expectedSize is invalid')
    if expected_sha != '-' and (len(expected_sha) != 64 or any(ch not in '0123456789abcdefABCDEF' for ch in expected_sha)):
        fail('expectedSha256 is invalid')
    root, parts = validated_relative(root, target)
    expected_target = os.path.join(root, *parts)
    root_fd, parent_fd, name = open_parent(root, parts)
    original_fd = None
    temp_name = None
    temp_fd = None
    try:
        original_fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent_fd)
        existing = os.fstat(original_fd)
        if descriptor_path(original_fd) != expected_target or not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
            fail('append target must be one physical regular file')
        if existing.st_size != expected_size:
            fail('append precondition failed: current size does not match expectedSize')
        before_hash = stream_hash(original_fd) if expected_sha != '-' else None
        if before_hash is not None and before_hash.lower() != expected_sha.lower():
            fail('append precondition failed: current hash does not match expectedSha256')
        temp_name = f'.iris-append-{os.getpid()}-{secrets.token_hex(16)}'
        temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
        os.lseek(original_fd, 0, os.SEEK_SET)
        while True:
            chunk = os.read(original_fd, CHUNK_BYTES)
            if not chunk:
                break
            write_all(temp_fd, chunk, 'append source copy could not be completed')
        write_all(temp_fd, payload, 'append payload could not be completed')
        os.fsync(temp_fd)
        temp_metadata = os.fstat(temp_fd)
        if not stat.S_ISREG(temp_metadata.st_mode) or temp_metadata.st_nlink != 1:
            fail('temporary append target lost isolated regular-file identity')
        revalidate_entry(parent_fd, name, original_fd, existing, expected_target)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if current.st_size != expected_size:
            fail('append precondition failed: target size changed before publication')
        if before_hash is not None:
            current_hash = stream_hash(original_fd)
            if current_hash != before_hash:
                fail('append precondition failed: target content changed before publication')
        os.rename(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temp_name = None
        os.fsync(parent_fd)
        output({'bytesAppended': len(payload), 'sizeBefore': expected_size, 'sizeAfter': expected_size + len(payload), 'mode': 'APPEND'})
    except FileNotFoundError:
        fail('append target does not exist')
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        if original_fd is not None:
            os.close(original_fd)
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


def main():
    if len(sys.argv) < 2:
        fail('operation is required')
    operation = sys.argv[1]
    if operation == 'hash-file' and len(sys.argv) == 4:
        hash_file(sys.argv[2], sys.argv[3])
        return
    if operation == 'read-text' and len(sys.argv) == 6:
        read_text(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        return
    if operation == 'read-range' and len(sys.argv) == 6:
        read_range(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        return
    if operation == 'write-create' and len(sys.argv) == 4:
        write_create(sys.argv[2], sys.argv[3])
        return
    if operation == 'write-replace' and len(sys.argv) == 4:
        write_replace(sys.argv[2], sys.argv[3])
        return
    if operation == 'append-file' and len(sys.argv) == 6:
        append_file(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        return
    fail('unsupported Phase 2 filesystem helper operation')


if __name__ == '__main__':
    main()
