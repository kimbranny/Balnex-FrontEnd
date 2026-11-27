// Minimal Metaplex Token Metadata (program metaqbxx…) instruction encoding and account
// parsing, written against the program's Borsh layout so BALNEX needs no new dependency.
// Pure byte logic with no Solana imports, so it can be unit-tested in plain Node.
//
// Instruction discriminators (Token Metadata program):
//   33 = CreateMetadataAccountV3     15 = UpdateMetadataAccountV2
const enc = new TextEncoder();
const dec = new TextDecoder();

export const MAX_NAME_BYTES = 32;
export const MAX_SYMBOL_BYTES = 10;
export const MAX_URI_BYTES = 200;

const u8 = (n) => Uint8Array.of(n);
const u16 = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
const u32 = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function borshString(value, max, label) {
  const bytes = enc.encode(value);
  if (bytes.length > max) throw new Error(`${label} is too long for on-chain metadata (max ${max} bytes).`);
  return concat([u32(bytes.length), bytes]);
}

export function encodeCreateMetadataV3({ name, symbol, uri = "", isMutable }) {
  return concat([
    u8(33),
    borshString(name, MAX_NAME_BYTES, "Token name"),
    borshString(symbol, MAX_SYMBOL_BYTES, "Token symbol"),
    borshString(uri, MAX_URI_BYTES, "Metadata URI"),
    u16(0), // seller fee basis points
    u8(0), // creators: None
    u8(0), // collection: None
    u8(0), // uses: None
    u8(isMutable ? 1 : 0),
    u8(0), // collection details: None
  ]);
}

// UpdateMetadataAccountV2 changing ONLY is_mutable -> false. Nothing else is touched.
export function encodeSetImmutable() {
  return concat([u8(15), u8(0), u8(0), u8(0), u8(1), u8(0)]);
  // data: None, new update authority: None, primary sale: None, is_mutable: Some(false)
}

// Parses just what BALNEX needs from a metadata account. Throws on unexpected layouts.
export function parseMetadataAccount(bytes, toBase58) {
  let o = 0;
  const key = bytes[o];
  o += 1;
  if (key !== 4) throw new Error("Not a Metadata account.");
  const updateAuthority = toBase58(bytes.slice(o, o + 32));
  o += 32;
  const mint = toBase58(bytes.slice(o, o + 32));
  o += 32;

  const readString = () => {
    const len = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    o += 4;
    if (len < 0 || o + len > bytes.length) throw new Error("Corrupt metadata string.");
    const text = dec.decode(bytes.slice(o, o + len)).replace(/\0+$/g, "");
    o += len;
    return text;
  };

  const name = readString();
  const symbol = readString();
  const uri = readString();
  o += 2; // seller fee basis points

  const hasCreators = bytes[o];
  o += 1;
  if (hasCreators === 1) {
    const count = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    o += 4 + count * 34;
  }

  o += 1; // primary_sale_happened
  const isMutable = bytes[o] === 1;
  if (bytes[o] !== 0 && bytes[o] !== 1) throw new Error("Unexpected metadata layout.");

  return { updateAuthority, mint, name, symbol, uri, isMutable };
}
