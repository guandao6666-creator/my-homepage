/**
 * shared/plugin-signature.js 的类型声明。
 * 运行时实现只有一份（JS），这里只补类型，避免 TS 端出现 any 泄漏。
 */

export const SIG_SPEC_VERSION: number;
export const SIG_ALGORITHM: string;
export const SIG_ENCODING: string;
export const SIG_PUBLIC_KEY_BYTES: number;
export const SIG_SIGNATURE_BYTES: number;
export const SIG_KEY_ID_PREFIX: string;
export const SIG_REGISTER_ACTION: string;
export const SIG_PROOF_TTL_MS: number;
export const SIG_FIELDS: readonly string[];

export const SIG_STATUS: {
  VERIFIED: "verified";
  UNSIGNED: "unsigned";
  INVALID: "invalid";
};

export type SignatureStatus = "verified" | "unsigned" | "invalid";

export type SignatureEnvelope = {
  spec: number;
  alg: string;
  keyId: string;
  publisherId: string;
  pluginId: string;
  version: string;
  format: string;
  formatVersion: number;
  filesDigest: string;
  manifestDigest: string;
  signedAt: number;
  sig: string;
};

export type SignatureIssue = { code: string; path: string; message: string };

export function base64urlEncode(bytes: Uint8Array): string;
export function base64urlDecode(text: string): Uint8Array | null;
export function utf8Bytes(text: string): Uint8Array;
export function sha256Hex(value: string | Uint8Array): Promise<string>;
export function bytesToHex(bytes: Uint8Array): string;
export function keyIdForPublicKey(publicKeyBytes: Uint8Array): Promise<string>;

export function buildSignatureEnvelope(input: {
  keyId: string;
  publisherId: string;
  pluginId: string;
  version: string;
  filesDigest: string;
  manifestDigest: string;
  signedAt?: number;
  spec?: number;
  algorithm?: string;
  format?: string;
  formatVersion?: number;
}): Record<string, string | number>;

export function signaturePayloadText(envelope: Record<string, unknown>): string;
export function signaturePayloadBytes(envelope: Record<string, unknown>): Uint8Array;
export function manifestDigest(manifest: unknown): Promise<string>;

export function validateSignatureEnvelope(raw: unknown): {
  ok: boolean;
  envelope: Record<string, any> | null;
  errors: SignatureIssue[];
};

export function verifyEd25519(
  publicKeyText: string,
  payloadBytes: Uint8Array,
  signatureBytes: Uint8Array,
): Promise<boolean>;

export function signEd25519(privateKey: CryptoKey, payloadBytes: Uint8Array): Promise<Uint8Array>;

export function bundleDigests(
  bundle: any,
  files?: any[],
): Promise<{ filesDigest: string; manifestDigest: string }>;

export type SignatureVerification = {
  status: SignatureStatus;
  code: string;
  message: string;
  errors: SignatureIssue[];
  details?: Record<string, unknown>;
};

export function verifyBundleSignature(input: {
  signature: unknown;
  bundle: any;
  publicKey: string;
  keyStatus?: "active" | "revoked";
  revokedAt?: number | null;
  signedAtFloor?: number | null;
  signedAtCeiling?: number | null;
  expected?: { publisherId?: string; pluginId?: string; version?: string };
}): Promise<SignatureVerification>;

export function registerProofPayloadText(input: {
  userId: string;
  publicKey: string;
  keyId: string;
  issuedAt: number;
}): string;

export function checkRegisterProof(input: {
  userId: string;
  publicKey: string;
  keyId: string;
  issuedAt: number;
  now?: number;
}): string;