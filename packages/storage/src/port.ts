export type StorageErrorCode =
  | 'INVALID_OBJECT_KEY'
  | 'OBJECT_EXISTS'
  | 'OBJECT_NOT_FOUND'
  | 'PATH_UNSAFE'
  | 'SIZE_MISMATCH'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'WRITE_FAILED';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface ObjectWriteRequest {
  readonly objectKey: string;
  readonly source: AsyncIterable<Uint8Array>;
  readonly declaredByteSize: number;
  readonly maxByteSize: number;
}

export interface ObjectStat {
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ObjectStorage {
  put(input: ObjectWriteRequest): Promise<ObjectStat>;
  open(objectKey: string): Promise<AsyncIterable<Uint8Array>>;
  delete(objectKey: string): Promise<void>;
  stat(objectKey: string): Promise<ObjectStat | null>;
  exists(objectKey: string): Promise<boolean>;
}
