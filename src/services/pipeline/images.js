/**
 * Bibliographic images → generate() images (moved from legacyBridge.js).
 */

/**
 * Map the form's images to the generate() request format.
 * @param {Array<{data:string, name?:string, type:string, size?:number}>} [images] - Form images (data URLs)
 * @returns {Array<{mimeType:string, dataUrl:string}>}
 */
export const toGenerateImages = (images) => (images || []).map((image) => ({ mimeType: image.type, dataUrl: image.data }));

/**
 * Image metadata only (what history stores): a new array; the input is not changed.
 * @param {Array<{name?:string, type?:string, size?:number, data?:string}>} [images] - Form images
 * @returns {Array<{name:string, type:string, size:number}>}
 */
export const imageMetadata = (images) => (Array.isArray(images) ? images : []).map((image) => ({
  name: typeof image?.name === 'string' ? image.name : '',
  type: typeof image?.type === 'string' ? image.type : '',
  size: Number.isFinite(image?.size) ? image.size : (typeof image?.data === 'string' ? image.data.length : 0)
}));

export default toGenerateImages;
