import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { chmod, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { once } from 'node:events';

import {
  StorageError,
  type ObjectStat,
  type ObjectStorage,
  type ObjectWriteRequest,
} from './port.js';

const SAFE_OBJECT_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class LocalFilesystemObjectStorage implements ObjectStorage {
  private readonly configuredRoot: string;

  constructor(root: string) {
    if (root.trim() === '') {
      throw new StorageError('PATH_UNSAFE', 'Storage root must not be empty');
    }
    this.configuredRoot = resolve(root);
  }

  async put(input: ObjectWriteRequest): Promise<ObjectStat> {
    validateWriteRequest(input);
    const root = await this.safeRoot();
    const target = this.objectPath(root, input.objectKey);
    const temporary = join(root, `.tmp-${randomUUID()}`);
    await ensureTargetDoesNotExist(target);

    const hash = createHash('sha256');
    let byteSize = 0;
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    try {
      for await (const rawChunk of input.source) {
        const chunk = Buffer.from(rawChunk);
        byteSize += chunk.byteLength;
        if (byteSize > input.maxByteSize) {
          throw new StorageError(
            'SIZE_LIMIT_EXCEEDED',
            'Object exceeded the configured byte limit',
          );
        }
        hash.update(chunk);
        if (!output.write(chunk)) {
          await once(output, 'drain');
        }
      }
      output.end();
      await once(output, 'close');
      if (byteSize !== input.declaredByteSize) {
        throw new StorageError(
          'SIZE_MISMATCH',
          'Declared and actual object sizes do not match',
        );
      }
      await rename(temporary, target);
      return { byteSize, sha256: hash.digest('hex') };
    } catch (error) {
      output.destroy();
      await waitForClose(output);
      await rm(temporary, { force: true });
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError('WRITE_FAILED', 'Object write failed');
    }
  }

  async open(objectKey: string): Promise<AsyncIterable<Uint8Array>> {
    const root = await this.safeRoot();
    const target = this.objectPath(root, objectKey);
    await requireRegularFile(target);
    return createReadStream(target) as ReadStream & AsyncIterable<Uint8Array>;
  }

  async delete(objectKey: string): Promise<void> {
    const root = await this.safeRoot();
    const target = this.objectPath(root, objectKey);
    const status = await safeLstat(target);
    if (status === null) {
      return;
    }
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new StorageError(
        'PATH_UNSAFE',
        'Object path is not a regular file',
      );
    }
    await rm(target);
  }

  async stat(objectKey: string): Promise<ObjectStat | null> {
    const root = await this.safeRoot();
    const target = this.objectPath(root, objectKey);
    const status = await safeLstat(target);
    if (status === null) {
      return null;
    }
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new StorageError(
        'PATH_UNSAFE',
        'Object path is not a regular file',
      );
    }
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const rawChunk of createReadStream(target)) {
      const chunk = Buffer.from(rawChunk);
      byteSize += chunk.byteLength;
      hash.update(chunk);
    }
    return { byteSize, sha256: hash.digest('hex') };
  }

  async exists(objectKey: string): Promise<boolean> {
    return (await this.stat(objectKey)) !== null;
  }

  private async safeRoot(): Promise<string> {
    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
    const status = await lstat(this.configuredRoot);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new StorageError('PATH_UNSAFE', 'Storage root must be a directory');
    }
    await chmod(this.configuredRoot, 0o700);
    const resolvedRoot = await realpath(this.configuredRoot);
    if (resolve(resolvedRoot) !== this.configuredRoot) {
      throw new StorageError(
        'PATH_UNSAFE',
        'Storage root must not be a symlink',
      );
    }
    return resolvedRoot;
  }

  private objectPath(root: string, objectKey: string): string {
    validateObjectKey(objectKey);
    if (isAbsolute(objectKey)) {
      throw new StorageError('INVALID_OBJECT_KEY', 'Absolute keys are invalid');
    }
    const target = resolve(join(root, objectKey));
    const pathFromRoot = relative(root, target);
    if (
      pathFromRoot === '' ||
      pathFromRoot.startsWith('..') ||
      isAbsolute(pathFromRoot) ||
      dirname(target) !== root
    ) {
      throw new StorageError('PATH_UNSAFE', 'Object path escaped storage root');
    }
    return target;
  }
}

async function waitForClose(
  output: NodeJS.WritableStream & { closed: boolean },
) {
  if (output.closed) {
    return;
  }
  await new Promise<void>((resolveClose) => {
    output.once('close', resolveClose);
  });
}

function validateWriteRequest(input: ObjectWriteRequest): void {
  validateObjectKey(input.objectKey);
  for (const value of [input.declaredByteSize, input.maxByteSize]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StorageError(
        'SIZE_MISMATCH',
        'Object sizes must be safe non-negative integers',
      );
    }
  }
  if (input.declaredByteSize > input.maxByteSize) {
    throw new StorageError(
      'SIZE_LIMIT_EXCEEDED',
      'Declared object size exceeds the configured limit',
    );
  }
}

function validateObjectKey(objectKey: string): void {
  if (!SAFE_OBJECT_KEY.test(objectKey)) {
    throw new StorageError(
      'INVALID_OBJECT_KEY',
      'Object key must be a server-generated UUID',
    );
  }
}

async function ensureTargetDoesNotExist(target: string): Promise<void> {
  const status = await safeLstat(target);
  if (status !== null) {
    throw new StorageError('OBJECT_EXISTS', 'Object key already exists');
  }
}

async function requireRegularFile(target: string): Promise<void> {
  const status = await safeLstat(target);
  if (status === null) {
    throw new StorageError('OBJECT_NOT_FOUND', 'Object does not exist');
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new StorageError('PATH_UNSAFE', 'Object path is not a regular file');
  }
}

async function safeLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
