import * as THREE from "three";

export function computeAverageTextureAlbedo(texture, fallbackReflectance) {
  if (!texture?.image) {
    return fallbackReflectance;
  }

  const image = texture.image;
  const width = image.width || image.naturalWidth || 0;
  const height = image.height || image.naturalHeight || 0;
  if (!width || !height) {
    return fallbackReflectance;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return fallbackReflectance;
  }
  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  const data = context.getImageData(0, 0, width, height).data;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  for (let i = 0; i < data.length; i += 4) {
    totalR += data[i];
    totalG += data[i + 1];
    totalB += data[i + 2];
  }

  const pixelCount = data.length / 4;
  const color = new THREE.Color(
    totalR / (255 * pixelCount),
    totalG / (255 * pixelCount),
    totalB / (255 * pixelCount),
  );
  color.convertSRGBToLinear();
  return color;
}

export function createTextureHelpers({
  textureLoader,
  maxAnisotropy,
  fallbackReflectance,
}) {
  function loadTexture(path, { repeatX, repeatY, isColor }) {
    const texture = textureLoader.load(
      path,
      (loadedTexture) => {
        if (isColor) {
          loadedTexture.userData.averageAlbedoColor = computeAverageTextureAlbedo(
            loadedTexture,
            fallbackReflectance,
          );
        }
      },
      undefined,
      () => {
        texture.userData.averageAlbedoColor = fallbackReflectance;
      },
    );

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.anisotropy = maxAnisotropy;
    texture.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return texture;
  }

  function loadTextureSet({
    colorPath,
    normalPath,
    roughnessPath,
    heightPath,
    repeatX,
    repeatY,
  }) {
    return {
      color: loadTexture(colorPath, { repeatX, repeatY, isColor: true }),
      normal: loadTexture(normalPath, { repeatX, repeatY, isColor: false }),
      roughness: loadTexture(roughnessPath, { repeatX, repeatY, isColor: false }),
      height: heightPath
        ? loadTexture(heightPath, { repeatX, repeatY, isColor: false })
        : null,
    };
  }

  function loadSpotlightMapTexture(path) {
    const texture = textureLoader.load(path);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = maxAnisotropy;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  return {
    loadTexture,
    loadTextureSet,
    loadSpotlightMapTexture,
  };
}
