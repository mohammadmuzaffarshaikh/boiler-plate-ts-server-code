/**
 * Create an object composed of the picked object properties
 * @param {Object | Object[]} object - The object (or array of objects) from which to pick properties
 * @param {string[]} keys - An array of strings representing the keys to pick (supports dot notation for nested keys)
 * @returns {Object} - An object composed of the picked properties
 */
function pick<T>(object: T | T[], keys: string[]): Record<string, any> {
  // If object is an array, we'll pick properties from each object in the array.
  if (Array.isArray(object)) {
    return object.map((item) => pick(item, keys)); // Recursively call pick on each item
  }

  return keys.reduce((obj: Record<string, any>, key: string) => {
    const keyParts = key.split(".");

    const value = keyParts.reduce((acc: any, part: string) => {
      return acc && acc[part] !== undefined ? acc[part] : undefined;
    }, object);

    if (value !== undefined) {
      keyParts.reduce((acc: any, part: string, index: number) => {
        if (index === keyParts.length - 1) {
          acc[part] = value;
        } else {
          acc[part] = acc[part] || {};
        }
        return acc[part];
      }, obj);
    }

    return obj;
  }, {});
}

export default pick;
