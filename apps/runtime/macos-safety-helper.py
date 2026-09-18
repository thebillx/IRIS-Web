#!/usr/bin/python3
import ctypes
import fcntl
import hashlib
import json
import os
import secrets
import stat
import sys

O_NOFOLLOW_ANY = 0x20000000
RENAME_SWAP = 0x00000002
F_GETPATH = 50
PATH_BUFFER_BYTES = 1024
PROC_PIDTBSDINFO = 3
MAXCOMLEN = 16
MAX_FILE_BYTES = 1024 * 1024


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ('pbi_flags', ctypes.c_uint32),
        ('pbi_status', ctypes.c_uint32),
        ('pbi_xstatus', ctypes.c_uint32),
        ('pbi_pid', ctypes.c_uint32),
        ('pbi_ppid', ctypes.c_uint32),
        ('pbi_uid', ctypes.c_uint32),
        ('pbi_gid', ctypes.c_uint32),
        ('pbi_ruid', ctypes.c_uint32),
        ('pbi_rgid', ctypes.c_uint32),
        ('pbi_svuid', ctypes.c_uint32),
        ('pbi_svgid', ctypes.c_uint32),
        ('rfu_1', ctypes.c_uint32),
        ('pbi_comm', ctypes.c_char * MAXCOMLEN),
        ('pbi_name', ctypes.c_char * (2 * MAXCOMLEN)),
        ('pbi_nfiles', ctypes.c_uint32),
        ('pbi_pgid', ctypes.c_uint32),
        ('pbi_pjobc', ctypes.c_uint32),
        ('e_tdev', ctypes.c_uint32),
        ('e_tpgid', ctypes.c_uint32),
        ('pbi_nice', ctypes.c_int32),
        ('pbi_start_tvsec', ctypes.c_uint64),
        ('pbi_start_tvusec', ctypes.c_uint64),
    ]


def fail(message):
    sys.stderr.write(json.dumps({'error': message}) + '\n')
    raise SystemExit(2)


def process_start(pid_text):
    try:
        pid = int(pid_text)
    except ValueError:
        fail('pid is invalid')
    if pid <= 0:
        fail('pid is invalid')
    info = ProcBsdInfo()
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int
    size = ctypes.sizeof(info)
    returned = libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size)
    if returned != size:
        error_number = ctypes.get_errno()
        if returned == 0 and error_number == 3:
            fail('process does not exist')
        fail('process identity is unavailable')
    sys.stdout.write(f'{info.pbi_start_tvsec}:{info.pbi_start_tvusec:06d}\n')


def validated_relative(root, target):
    if not os.path.isabs(root) or not os.path.isabs(target):
        fail('project root and target must be absolute')
    root = os.path.normpath(root)
    target = os.path.normpath(target)
    if os.path.realpath(root) != root:
        fail('project root is not a stable physical directory')
    relative = os.path.relpath(target, root)
    if relative in ('.', '..') or os.path.isabs(relative) or relative.startswith('..' + os.sep):
        fail('target escapes project root or names the project root')
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
        fail('read target pathname identity is unavailable')
    return os.path.normpath(os.fsdecode(raw.split(b'\0', 1)[0]))


def read_project_file(root, target):
    root, parts = validated_relative(root, target)
    expected_target = os.path.join(root, *parts)
    root_fd, parent_fd, name = open_parent(root, parts)
    file_fd = None
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent_fd)
        metadata = os.fstat(file_fd)
        if descriptor_path(file_fd) != expected_target:
            fail('read target pathname no longer identifies the project entry')
        if not stat.S_ISREG(metadata.st_mode):
            fail('read target is not a regular file')
        if metadata.st_nlink != 1:
            fail('hard-linked files are outside the safe project read model')
        if metadata.st_size > MAX_FILE_BYTES:
            fail('read target exceeds the bounded file size')
        chunks = []
        remaining = MAX_FILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b''.join(chunks)
        if len(content) > MAX_FILE_BYTES:
            fail('read target exceeds the bounded file size')
        after = os.fstat(file_fd)
        try:
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            fail('read target project entry disappeared during execution')
        if (after.st_nlink != 1
                or after.st_dev != metadata.st_dev
                or after.st_ino != metadata.st_ino
                or not stat.S_ISREG(current.st_mode)
                or current.st_nlink != 1
                or current.st_dev != metadata.st_dev
                or current.st_ino != metadata.st_ino
                or descriptor_path(file_fd) != expected_target):
            fail('read target identity changed during execution')
        sys.stdout.write(json.dumps({'content': content.decode('utf-8', errors='replace')}, separators=(',', ':')) + '\n')
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


def write_project_file(root, target):
    payload = sys.stdin.buffer.read(MAX_FILE_BYTES + 1)
    if len(payload) > MAX_FILE_BYTES:
        fail('write payload exceeds the bounded file size')
    root, parts = validated_relative(root, target)
    root_fd, parent_fd, name = open_parent(root, parts)
    temp_name = f'.iris-write-{os.getpid()}-{secrets.token_hex(16)}'
    temp_fd = None
    existing = None
    try:
        try:
            existing = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(existing.st_mode):
                fail('write target is not a regular file')
            if existing.st_nlink != 1:
                fail('hard-linked files are outside the safe project write model')
        except FileNotFoundError:
            existing = None

        temp_fd = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        written = 0
        while written < len(payload):
            count = os.write(temp_fd, payload[written:])
            if count <= 0:
                fail('write payload could not be completed')
            written += count
        os.fsync(temp_fd)
        temp_metadata = os.fstat(temp_fd)
        if not stat.S_ISREG(temp_metadata.st_mode) or temp_metadata.st_nlink != 1:
            fail('temporary project write target lost isolated regular-file identity')

        try:
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if existing is None:
            if current is not None:
                fail('write target appeared during execution')
        else:
            if current is None:
                fail('write target disappeared during execution')
            if (not stat.S_ISREG(current.st_mode)
                    or current.st_nlink != 1
                    or current.st_dev != existing.st_dev
                    or current.st_ino != existing.st_ino):
                fail('write target identity changed during execution')

        temp_metadata = os.fstat(temp_fd)
        if temp_metadata.st_nlink != 1:
            fail('temporary project write target was hard-linked during execution')
        os.rename(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
        sys.stdout.write(json.dumps({'bytes': len(payload)}, separators=(',', ':')) + '\n')
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        try:
            os.unlink(temp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


def edit_project_file(root, target):
    try:
        request = json.loads(sys.stdin.buffer.read(MAX_FILE_BYTES + 1).decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        fail('edit request is not valid UTF-8 JSON')
    if not isinstance(request, dict):
        fail('edit request must be an object')
    find = request.get('find')
    replace = request.get('replace')
    expected = request.get('expectedSha256')
    dry_run = request.get('dryRun', False)
    if not isinstance(find, str) or len(find) == 0:
        fail('edit find text must be a non-empty string')
    if not isinstance(replace, str):
        fail('edit replacement must be a string')
    if len(find.encode('utf-8')) > MAX_FILE_BYTES or len(replace.encode('utf-8')) > MAX_FILE_BYTES:
        fail('edit text exceeds the bounded file size')
    if not isinstance(expected, str) or len(expected) != 64 or any(character not in '0123456789abcdefABCDEF' for character in expected):
        fail('edit expectedSha256 must be a SHA-256 hex digest')
    if not isinstance(dry_run, bool):
        fail('edit dryRun must be boolean')

    root, parts = validated_relative(root, target)
    expected_target = os.path.join(root, *parts)
    root_fd, parent_fd, name = open_parent(root, parts)
    file_fd = None
    temp_name = None
    temp_fd = None
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent_fd)
        metadata = os.fstat(file_fd)
        if descriptor_path(file_fd) != expected_target:
            fail('edit target pathname no longer identifies the project entry')
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail('edit target must be one physical regular file')
        if metadata.st_size > MAX_FILE_BYTES:
            fail('edit target exceeds the bounded file size')
        original_bytes = read_bounded(file_fd)
        try:
            original = original_bytes.decode('utf-8')
        except UnicodeDecodeError:
            fail('edit target is not valid UTF-8; refusing an encoding-changing edit')
        before_sha256 = hashlib.sha256(original_bytes).hexdigest()
        if before_sha256.lower() != expected.lower():
            fail('edit precondition failed: current content hash does not match expectedSha256')
        matches = original.count(find)
        if matches == 0:
            fail('edit target text was not found')
        if matches != 1:
            fail(f'edit target text is ambiguous: found {matches} matches')
        updated = original.replace(find, replace, 1)
        updated_bytes = updated.encode('utf-8')
        if len(updated_bytes) > MAX_FILE_BYTES:
            fail('edited file exceeds the bounded file size')
        after_sha256 = hashlib.sha256(updated_bytes).hexdigest()

        current = read_current_bytes(root, parent_fd, name, expected_target, metadata)
        if hashlib.sha256(current).hexdigest() != before_sha256:
            fail('edit precondition failed: target content changed during execution')
        if dry_run:
            sys.stdout.write(json.dumps({
                'changed': updated_bytes != original_bytes,
                'beforeSha256': before_sha256,
                'afterSha256': after_sha256,
                'bytesBefore': len(original_bytes),
                'bytesAfter': len(updated_bytes),
                'matchCount': matches,
                'dryRun': True,
            }, separators=(',', ':')) + '\n')
            return

        temp_name = f'.iris-edit-{os.getpid()}-{secrets.token_hex(16)}'
        temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
        written = 0
        while written < len(updated_bytes):
            count = os.write(temp_fd, updated_bytes[written:])
            if count <= 0:
                fail('edited payload could not be completed')
            written += count
        os.fsync(temp_fd)
        temp_metadata = os.fstat(temp_fd)
        if not stat.S_ISREG(temp_metadata.st_mode) or temp_metadata.st_nlink != 1:
            fail('temporary edit target lost isolated regular-file identity')
        current = read_current_bytes(root, parent_fd, name, expected_target, metadata)
        if hashlib.sha256(current).hexdigest() != before_sha256:
            fail('edit precondition failed: target content changed before publication')
        os.rename(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
        sys.stdout.write(json.dumps({
            'changed': updated_bytes != original_bytes,
            'beforeSha256': before_sha256,
            'afterSha256': after_sha256,
            'bytesBefore': len(original_bytes),
            'bytesAfter': len(updated_bytes),
            'matchCount': matches,
            'dryRun': False,
        }, separators=(',', ':')) + '\n')
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        if file_fd is not None:
            os.close(file_fd)
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


def read_bounded(file_fd):
    chunks = []
    remaining = MAX_FILE_BYTES + 1
    while remaining > 0:
        chunk = os.read(file_fd, min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    content = b''.join(chunks)
    if len(content) > MAX_FILE_BYTES:
        fail('target exceeds the bounded file size')
    return content


def read_current_bytes(root, parent_fd, name, expected_target, expected_metadata):
    current_fd = None
    try:
        current_fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent_fd)
        current_metadata = os.fstat(current_fd)
        if (descriptor_path(current_fd) != expected_target
                or not stat.S_ISREG(current_metadata.st_mode)
                or current_metadata.st_nlink != 1
                or current_metadata.st_dev != expected_metadata.st_dev
                or current_metadata.st_ino != expected_metadata.st_ino):
            fail('edit target identity changed during execution')
        return read_bounded(current_fd)
    except FileNotFoundError:
        fail('edit target disappeared during execution')
    finally:
        if current_fd is not None:
            os.close(current_fd)


def swap_private_files(root, left_name, right_name):
    if not os.path.isabs(root):
        fail('swap root must be absolute')
    root = os.path.normpath(root)
    try:
        root_metadata = os.lstat(root)
    except OSError:
        fail('swap root metadata is unavailable')
    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        fail('swap root is not a physical directory')
    root = os.path.realpath(root)
    if any(name in ('', '.', '..') or os.sep in name for name in (left_name, right_name)):
        fail('swap names must be direct child names')
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | O_NOFOLLOW_ANY)
    try:
        libsystem = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        libsystem.renameatx_np.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        libsystem.renameatx_np.restype = ctypes.c_int
        result = libsystem.renameatx_np(
            root_fd,
            left_name.encode('utf-8'),
            root_fd,
            right_name.encode('utf-8'),
            RENAME_SWAP,
        )
        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        os.fsync(root_fd)
        sys.stdout.write(json.dumps({'swapped': True}, separators=(',', ':')) + '\n')
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        os.close(root_fd)


def mutate(operation, root, target):
    root, parts = validated_relative(root, target)
    root_fd, parent_fd, name = open_parent(root, parts)
    try:
        if operation == 'unlink':
            metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(metadata.st_mode):
                fail('delete target is not a regular file')
            if metadata.st_nlink != 1:
                fail('hard-linked files are outside the safe project mutation model')
            os.unlink(name, dir_fd=parent_fd)
            result = {'deleted': True}
        elif operation == 'mkdir':
            try:
                os.mkdir(name, mode=0o700, dir_fd=parent_fd)
                result = {'created': True}
            except FileExistsError:
                metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if not stat.S_ISDIR(metadata.st_mode):
                    fail('existing target is not a physical directory')
                result = {'created': False}
        elif operation == 'rmdir':
            metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(metadata.st_mode):
                fail('delete target is not a physical directory')
            os.rmdir(name, dir_fd=parent_fd)
            result = {'deleted': True}
        else:
            fail('unsupported helper operation')
        sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    except OSError as error:
        fail(f'filesystem operation failed: {error.strerror or error.__class__.__name__}')
    finally:
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


def main():
    if len(sys.argv) < 2:
        fail('operation is required')
    operation = sys.argv[1]
    if operation == 'process-start':
        if len(sys.argv) != 3:
            fail('process-start requires pid')
        process_start(sys.argv[2])
        return
    if operation == 'read-file':
        if len(sys.argv) != 4:
            fail('read-file requires project root and target')
        read_project_file(sys.argv[2], sys.argv[3])
        return
    if operation == 'write-file':
        if len(sys.argv) != 4:
            fail('write-file requires project root and target')
        write_project_file(sys.argv[2], sys.argv[3])
        return
    if operation == 'edit-file':
        if len(sys.argv) != 4:
            fail('edit-file requires project root and target')
        edit_project_file(sys.argv[2], sys.argv[3])
        return
    if operation == 'swap-files':
        if len(sys.argv) != 5:
            fail('swap-files requires root and two direct child names')
        swap_private_files(sys.argv[2], sys.argv[3], sys.argv[4])
        return
    if operation in ('unlink', 'mkdir', 'rmdir'):
        if len(sys.argv) != 4:
            fail('filesystem operation requires project root and target')
        mutate(operation, sys.argv[2], sys.argv[3])
        return
    fail('unsupported helper operation')


if __name__ == '__main__':
    main()
