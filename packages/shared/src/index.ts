import { isAbsolute, normalize, resolve, sep } from 'node:path';

export function validatePathWithinRoot(candidate: string, allowedRoot: string): string {
  if (!candidate || !allowedRoot || !isAbsolute(candidate) || !isAbsolute(allowedRoot)) {
    throw new Error('Candidate and allowed root must be absolute paths');
  }

  const root = normalize(resolve(allowedRoot));
  const resolvedCandidate = normalize(resolve(candidate));
  if (resolvedCandidate !== root && !resolvedCandidate.startsWith(`${root}${sep}`)) {
    throw new Error('Path is outside the allowed root');
  }
  return resolvedCandidate;
}
