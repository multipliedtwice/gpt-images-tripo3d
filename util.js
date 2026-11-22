export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const errorWith = (message, code) => Object.assign(new Error(message), { code });
export const withTimeout = async (promise, ms, message, code = "STUDIO_TIMEOUT") => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(errorWith(message, code)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};
export const isMissingReceiver = error => /Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(error?.message || "");
