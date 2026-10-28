const DirectBinary = require('@adobe/aem-upload');

function normalizeHost(host) {
  let url;
  try {
    url = new URL(host);
  } catch {
    throw new Error('AEM host must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('AEM host must be a credential-free HTTPS origin');
  }
  return url.origin;
}

function validateFolder(folder) {
  if (
    typeof folder !== 'string' ||
    !folder.startsWith('/content/dam/') ||
    folder.includes('//') ||
    folder.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('AEM upload folder must be a specific folder under /content/dam');
  }
  return folder.replace(/\/$/, '');
}

function validateFilename(filename) {
  if (typeof filename !== 'string' || !/^synthetic-[a-zA-Z0-9-]+\.jpg$/.test(filename)) {
    throw new Error('Upload filename must be a synthetic .jpg name');
  }
}

function uploadErrors(result) {
  const errors = Array.isArray(result && result.errors) ? [...result.errors] : [];
  for (const file of (result && Array.isArray(result.detailedResult) ? result.detailedResult : [])) {
    if (file.result && Array.isArray(file.result.errors)) errors.push(...file.result.errors);
  }
  return errors;
}

async function uploadAsset({ host, token, folder, filename, filePath, fileSize }, sdk = DirectBinary) {
  const origin = normalizeHost(host);
  const assetFolder = validateFolder(folder);
  validateFilename(filename);
  if (typeof token !== 'string' || !token.trim()) throw new Error('AEM bearer token is required');
  if (typeof filePath !== 'string' || !filePath) throw new Error('Image file path is required');
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('Image file size must be positive');

  const targetUrl = `${origin}${assetFolder.split('/').map(encodeURIComponent).join('/')}`;
  const upload = new sdk.DirectBinaryUpload();
  const options = new sdk.DirectBinaryUploadOptions()
    .withUrl(targetUrl)
    .withUploadFiles([{ fileName: filename, fileSize, filePath }])
    .withHttpOptions({ headers: { Authorization: `Bearer ${token}` } })
    .withConcurrent(false);
  const result = await upload.uploadFiles(options);
  const errors = uploadErrors(result);
  if (!result || result.totalCompleted !== 1 || errors.length) {
    const detail = errors[0] && (errors[0].message || errors[0].code);
    throw new Error(detail ? `AEM upload SDK failed: ${detail}` : 'AEM upload SDK did not confirm the upload');
  }
  return { assetPath: `${assetFolder}/${filename}` };
}

module.exports = { uploadAsset, normalizeHost, validateFolder, validateFilename };
