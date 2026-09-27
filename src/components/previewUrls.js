/**
 * Object URLs of the uploaded-image previews (HOUSE_RULES 12). Every URL is
 * tracked from creation; it is revoked when its image is removed, and all
 * outstanding URLs are revoked when the form unmounts (after a successful
 * Suggest, an error, or a cancel that leaves the step).
 */

/**
 * Create a tracker of preview object URLs.
 * @returns {{create:(file:Blob)=>string, revoke:(url:string)=>void, revokeAll:()=>void, outstanding:()=>string[]}}
 */
export const createPreviewTracker = () => {
  const urls = new Set();
  return {
    create: (file) => {
      const url = URL.createObjectURL(file);
      urls.add(url);
      return url;
    },
    revoke: (url) => {
      if (!urls.has(url)) return;
      urls.delete(url);
      URL.revokeObjectURL(url);
    },
    revokeAll: () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    },
    outstanding: () => [...urls]
  };
};

export default createPreviewTracker;
