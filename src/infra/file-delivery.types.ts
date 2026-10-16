export type FileDeliveryRequestV1 = {
  version: 1;
  data: Uint8Array;
  displayName: string;
};

export type FileDeliveryResultV1 = {
  version: 1;
  url: string;
  objectKey: string;
  size: number;
};
