// Koishi loads its plugins through CommonJS. Both entry points must share the host's service registry.
import sticker from "./lib/index.cjs";

export const {
  ReviewQueue,
  StickerReviewer,
  StickerStore,
  buildStickerElement,
  detectStickerMime,
  gifFirstFrameToPng,
  importFromDirectory,
  mimeForFilename,
  sha256Hex,
  validateCandidateBytes,
} = sticker;
export default sticker.default;
