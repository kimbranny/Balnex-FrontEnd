// Metaplex Token Metadata helpers (Update Authority).
//
// "Update authority" lives in a token's Metaplex metadata account. Revoking it means
// setting the account's is_mutable flag to false via UpdateMetadataAccountV2, which
// permanently locks name, symbol, URI and the update authority itself. (The program has no
// way to set the update authority to "none"; immutability is the standard revocation.)
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { encodeCreateMetadataV3, encodeSetImmutable, parseMetadataAccount } from "./metadataCodec";

export const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

export function findMetadataPda(mint) {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("metadata"), TOKEN_METADATA_PROGRAM_ID.toBytes(), new PublicKey(mint).toBytes()],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

export function createMetadataInstruction({ mint, owner, name, symbol, uri = "", isMutable }) {
  const metadata = findMetadataPda(mint);
  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false }, // mint authority
      { pubkey: owner, isSigner: true, isWritable: true }, // payer
      { pubkey: owner, isSigner: true, isWritable: false }, // update authority
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeCreateMetadataV3({ name, symbol, uri, isMutable })),
  });
}

export function setImmutableInstruction({ mint, owner }) {
  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: findMetadataPda(mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(encodeSetImmutable()),
  });
}

// Reads the metadata account from the chain.
//   { status: "none" }                      no metadata account (created without metadata)
//   { status: "unsupported", reason }       exists but isn't a standard Metaplex metadata account
//   { status: "ok", updateAuthority, isMutable, name, symbol, uri }
export async function readMetadata(connection, mint) {
  const pda = findMetadataPda(mint);
  const info = await connection.getAccountInfo(pda, "confirmed");
  if (!info) return { status: "none" };
  if (!info.owner.equals(TOKEN_METADATA_PROGRAM_ID)) {
    return { status: "unsupported", reason: "The metadata account isn't owned by the Token Metadata program." };
  }
  try {
    const parsed = parseMetadataAccount(info.data, (b) => new PublicKey(b).toBase58());
    return { status: "ok", ...parsed };
  } catch (err) {
    return { status: "unsupported", reason: err?.message || "Unrecognised metadata layout." };
  }
}
