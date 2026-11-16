const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("tripo-folder-runner", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("preferences");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const getPreference = async key => {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("preferences", "readonly");
      const request = transaction.objectStore("preferences").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
};

export const setPreference = async (key, value) => {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("preferences", "readwrite");
      transaction.objectStore("preferences").put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Could not save the folder selection."));
    });
  } finally {
    database.close();
  }
};
