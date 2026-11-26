/** Plugin partition-local storage; native hosts supply their own account/route-scoped adapter. */
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('umeda-kos-workbench-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('values');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(new Error('无法打开本机工作台存储。')); };
  });
  return database;
}
export async function localValue(operation: 'get' | 'set' | 'remove', key: string, value?: string): Promise<string | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('values', operation === 'get' ? 'readonly' : 'readwrite'), store = transaction.objectStore('values');
    let result: string | null = null;
    if (operation === 'get') { const request = store.get(key); request.onsuccess = () => { result = request.result ?? null; }; }
    else if (operation === 'set') store.put(value, key); else store.delete(key);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(new Error('本机空间不足或保存失败，内容仍保留在编辑器中。'));
  });
}
