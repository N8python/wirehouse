export function inferWallHeightTexture(textureSet) {
  if (textureSet?.height) {
    return textureSet.height;
  }

  if (textureSet?.color) {
    textureSet.color.userData.inferredHeight = "luma+normal-slope";
    return textureSet.color;
  }

  if (textureSet?.roughness) {
    textureSet.roughness.userData.inferredHeight = "invert-roughness";
    return textureSet.roughness;
  }

  return null;
}

export function applyParallaxOcclusionToMaterial(
  material,
  heightTexture,
  pomUniforms,
  programCacheKey = "pom-v1",
) {
  if (!material || !heightTexture) {
    return;
  }

  material.onBeforeCompile = (shader) => {
    shader.uniforms.pomHeightMap = { value: heightTexture };
    shader.uniforms.pomHeightScale = pomUniforms.heightScale;
    shader.uniforms.pomMinLayers = pomUniforms.minLayers;
    shader.uniforms.pomMaxLayers = pomUniforms.maxLayers;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D pomHeightMap;
uniform float pomHeightScale;
uniform float pomMinLayers;
uniform float pomMaxLayers;

vec3 pomComputeNormalVS(vec3 positionVS) {
  vec3 dpdx = dFdx(positionVS);
  vec3 dpdy = dFdy(positionVS);
  vec3 normalVS = normalize(cross(dpdx, dpdy));
  return gl_FrontFacing ? normalVS : -normalVS;
}

mat3 pomCotangentFrame(vec3 normalVS, vec3 positionVS, vec2 uv) {
  vec3 dp1 = dFdx(positionVS);
  vec3 dp2 = dFdy(positionVS);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);

  vec3 dp2perp = cross(dp2, normalVS);
  vec3 dp1perp = cross(normalVS, dp1);
  vec3 tangent = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 bitangent = dp2perp * duv1.y + dp1perp * duv2.y;

  float invmax = inversesqrt(max(dot(tangent, tangent), dot(bitangent, bitangent)));
  return mat3(tangent * invmax, bitangent * invmax, normalVS);
}

float pomSampleHeight(vec2 uv) {
  vec3 sourceColor = texture2D(pomHeightMap, uv).rgb;
  float lumaHeight = dot(sourceColor, vec3(0.2126, 0.7152, 0.0722));
  return clamp(lumaHeight, 0.0, 1.0);
}

vec4 pomTexture2D(sampler2D tex, vec2 uv, vec2 gradX, vec2 gradY, float mipBias) {
#if __VERSION__ >= 300
  return textureGrad(tex, uv, gradX, gradY);
#elif defined(GL_EXT_shader_texture_lod)
  return texture2DGradEXT(tex, uv, gradX, gradY);
#else
  return texture2D(tex, uv, mipBias);
#endif
}

vec2 parallaxOcclusionUV(vec2 uv, out vec2 displacedGradX, out vec2 displacedGradY, out float mipBias) {
  vec3 positionVS = -vViewPosition;
  vec3 normalVS = pomComputeNormalVS(positionVS);
  float heightScale = pomHeightScale;
  vec2 uvGradX = dFdx(uv);
  vec2 uvGradY = dFdy(uv);
  if (heightScale <= 0.00001) {
    displacedGradX = uvGradX;
    displacedGradY = uvGradY;
    mipBias = 0.0;
    return uv;
  }

  vec3 viewDirVS = normalize(vViewPosition);
  mat3 tbn = pomCotangentFrame(normalVS, positionVS, uv);
  vec3 viewDirTS = normalize(
    vec3(dot(viewDirVS, tbn[0]), dot(viewDirVS, tbn[1]), dot(viewDirVS, tbn[2]))
  );

  float viewZ = max(abs(viewDirTS.z), 0.06);
  float grazingFade = smoothstep(0.07, 0.35, viewZ);
  heightScale *= grazingFade;
  if (heightScale <= 0.00001) {
    displacedGradX = uvGradX;
    displacedGradY = uvGradY;
    mipBias = 0.0;
    return uv;
  }
  float invViewZ = 1.0 / viewZ;
  vec2 proj = viewDirTS.xy * invViewZ;
  float projectedParallax = length(proj) * heightScale;
  if (projectedParallax <= 0.0015) {
    displacedGradX = uvGradX;
    displacedGradY = uvGradY;
    mipBias = 0.0;
    return uv;
  }
  float numLayers = mix(pomMaxLayers, pomMinLayers, abs(viewZ));
  float layerDepth = 1.0 / numLayers;
  vec2 deltaUv = proj * (heightScale / numLayers);

  vec2 currentUv = uv;
  vec2 previousUv = uv;
  float currentLayerDepth = 0.0;
  float currentHeight = pomSampleHeight(currentUv);
  float previousHeight = currentHeight;
  float previousLayerDepth = currentLayerDepth;

  for (int i = 0; i < 32; i++) {
    if (float(i) >= numLayers || currentLayerDepth >= currentHeight) {
      break;
    }

    previousUv = currentUv;
    previousHeight = currentHeight;
    previousLayerDepth = currentLayerDepth;

    currentUv -= deltaUv;
    currentLayerDepth += layerDepth;
    currentHeight = pomSampleHeight(currentUv);
  }

  float finalTravel;
  if (currentLayerDepth >= currentHeight) {
    float lowerTravel = previousLayerDepth;
    float upperTravel = currentLayerDepth;
    for (int i = 0; i < 3; i++) {
      float midTravel = 0.5 * (lowerTravel + upperTravel);
      vec2 midUv = uv - proj * (heightScale * midTravel);
      float midHeight = pomSampleHeight(midUv);
      if (midTravel < midHeight) {
        lowerTravel = midTravel;
      } else {
        upperTravel = midTravel;
      }
    }
    finalTravel = 0.5 * (lowerTravel + upperTravel);
  } else {
    float after = currentHeight - currentLayerDepth;
    float before = previousHeight - previousLayerDepth;
    float denom = after - before;
    float weight = abs(denom) > 0.00001 ? clamp(after / denom, 0.0, 1.0) : 0.0;
    finalTravel = mix(currentLayerDepth, previousLayerDepth, weight);
  }
  vec2 finalUv = uv - proj * (heightScale * finalTravel);

  vec3 dViewDirTSdx = dFdx(viewDirTS);
  vec3 dViewDirTSdy = dFdy(viewDirTS);
  float viewZSign = sign(viewDirTS.z);
  float dViewZdx = viewZSign * dViewDirTSdx.z;
  float dViewZdy = viewZSign * dViewDirTSdy.z;
  vec2 dProjDx =
    (dViewDirTSdx.xy * viewZ - viewDirTS.xy * dViewZdx) / max(viewZ * viewZ, 0.00001);
  vec2 dProjDy =
    (dViewDirTSdy.xy * viewZ - viewDirTS.xy * dViewZdy) / max(viewZ * viewZ, 0.00001);
  float scaleTravel = heightScale * finalTravel;
  vec2 dOffsetDx = dProjDx * scaleTravel;
  vec2 dOffsetDy = dProjDy * scaleTravel;
  displacedGradX = uvGradX - dOffsetDx;
  displacedGradY = uvGradY - dOffsetDy;

  float normalizedDelta = length(finalUv - uv) / max(heightScale, 0.0001);
  mipBias = -clamp(normalizedDelta * 0.7 + (1.0 - viewZ) * 0.85, 0.0, 2.0);
  return finalUv;
}
`,
      )
      .replace(
        "void main() {",
        `void main() {
	vec2 pomGradX;
	vec2 pomGradY;
	float pomMipBias;
	vec2 pomSharedUv = parallaxOcclusionUV( vMapUv, pomGradX, pomGradY, pomMipBias );`,
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
	vec4 sampledDiffuseColor = pomTexture2D( map, pomSharedUv, pomGradX, pomGradY, pomMipBias );

	#ifdef DECODE_VIDEO_TEXTURE

		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );

	#endif

	diffuseColor *= sampledDiffuseColor;

#endif`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#ifdef USE_NORMALMAP_OBJECTSPACE

	normal = pomTexture2D( normalMap, pomSharedUv, pomGradX, pomGradY, pomMipBias ).xyz * 2.0 - 1.0;

	#ifdef FLIP_SIDED

		normal = - normal;

	#endif

	#ifdef DOUBLE_SIDED

		normal = normal * faceDirection;

	#endif

	normal = normalize( normalMatrix * normal );

#elif defined( USE_NORMALMAP_TANGENTSPACE )

	vec3 mapN = pomTexture2D( normalMap, pomSharedUv, pomGradX, pomGradY, pomMipBias ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;

	normal = normalize( tbn * mapN );

#elif defined( USE_BUMPMAP )

	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );

#endif`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;

#ifdef USE_ROUGHNESSMAP

	vec4 texelRoughness = pomTexture2D( roughnessMap, pomSharedUv, pomGradX, pomGradY, pomMipBias );
	roughnessFactor *= texelRoughness.g;

#endif`,
      );
  };

  material.customProgramCacheKey = () => programCacheKey;
  material.needsUpdate = true;
}
