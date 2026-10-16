/*
 * Witchcraft personal-library privacy bundle — jose 6.2.12 inlined.
 *
 * Reproducible build (esbuild 0.28.2, already installed; no new dependency):
 *   esbuild bundle-entry.mjs --bundle --format=esm --platform=browser \
 *     --target=es2022 --legal-comments=eof --banner:js="<this banner>" \
 *     --outfile=personal-library.bundle.mjs
 * built inside: .../personal-library/candidate  (bundle-entry.mjs re-exports
 * the accepted candidate's public surface). The jose LICENSE text is appended
 * below as a comment block to preserve the dependency licence.
 *
 * Bundled dependency: jose 6.2.12 — MIT License, Copyright (c) 2018 Filip Skokan.
 *
 * Source hashes (see BUNDLE.md / personal-finish MANIFEST.json):
 *   principal.mjs        cd4175cbcc34dbd47ce9f3d39e5bdb577b653bfc1b20d786946e3aab036d6653
 *   library.mjs          0f749c098123fee1a95d18a75cd831ce8d445c0ebbb68e0b7fd1b3dde12c8df4
 *   hosted-registry.mjs  3ce8cc1b470524cae52ef74df83a4ae3d5ce24bf31cd81589b98a5d8d409fd9c
 *   mirror.mjs           0c6a052b100b66734ad697431a776a2b3556cb85654230bb74f54a94d42acaf8
 *   session-bind.mjs     e070b5f22c58ab6f554fde57170722f4a775b97f4ba0c56773a93ad690112cfb
 *   worker.mjs           d5918777195fa9ce767822f3fd4199cf7ecc53558983d4bcce2c4b5bd5592c5d
 *
 * Offline staged artefact. NOT deployed. This is the accepted candidate's own
 * verified implementations; no new crypto is added here.
 */

/* --------------------------------------------------------------------------
 * jose 6.2.12 — MIT License (MIT)
 * Copyright (c) 2018 Filip Skokan
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * -------------------------------------------------------------------------- */
// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var strictDecoder = new TextDecoder("utf-8", { fatal: true });
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0), buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers)
    buf.set(buffer, i), i += buffer.length;
  return buf;
}
var NON_ASCII = /[^\x00-\x7f]/;
function encode(string) {
  if (typeof string == "string" && string.length >= 128) {
    if (NON_ASCII.test(string))
      throw new TypeError("non-ASCII string encountered in encode()");
    return encoder.encode(string);
  }
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127)
      throw new TypeError("non-ASCII string encountered in encode()");
    bytes[i] = code;
  }
  return bytes;
}
function decodeBase64(encoded, url = false) {
  if (Uint8Array.fromBase64)
    return Uint8Array.fromBase64(encoded, { alphabet: url ? "base64url" : "base64" });
  if (url) {
    if (encoded.includes("+") || encoded.includes("/"))
      throw new TypeError("Invalid base64url");
    encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  }
  const binary = atob(encoded), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options), this.name = this.constructor.name, Error.captureStackTrace?.(this, this.constructor);
  }
};
var JWTClaimValidationFailed = class extends JOSEError {
  static code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
};
var JWTExpired = class extends JOSEError {
  static code = "ERR_JWT_EXPIRED";
  code = "ERR_JWT_EXPIRED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
};
var JOSEAlgNotAllowed = class extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
};
var JOSENotSupported = class extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWSInvalid = class extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWTInvalid = class extends JOSEError {
  static code = "ERR_JWT_INVALID";
  code = "ERR_JWT_INVALID";
};
var JWKSInvalid = class extends JOSEError {
  static code = "ERR_JWKS_INVALID";
  code = "ERR_JWKS_INVALID";
};
var JWKSNoMatchingKey = class extends JOSEError {
  static code = "ERR_JWKS_NO_MATCHING_KEY";
  code = "ERR_JWKS_NO_MATCHING_KEY";
  constructor(message2 = "no applicable key found in the JSON Web Key Set", options) {
    super(message2, options);
  }
};
var JWKSMultipleMatchingKeys = class extends JOSEError {
  [Symbol.asyncIterator] = async function* () {
  };
  static code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  constructor(message2 = "multiple matching keys found in the JSON Web Key Set", options) {
    super(message2, options);
  }
};
var JWKSTimeout = class extends JOSEError {
  static code = "ERR_JWKS_TIMEOUT";
  code = "ERR_JWKS_TIMEOUT";
  constructor(message2 = "request timed out", options) {
    super(message2, options);
  }
};
var JWSSignatureVerificationFailed = class extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
};

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/util/base64url.js
var invalid = "The input to be decoded is not correctly encoded.";
function decode(input) {
  try {
    return decodeBase64(typeof input == "string" ? input : decoder.decode(input), true);
  } catch (cause) {
    throw new TypeError(invalid, { cause });
  }
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/lib/validate.js
function isObject(input) {
  if (typeof input != "object" || input === null || Object.prototype.toString.call(input) !== "[object Object]")
    return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function isJwkSet(input) {
  return isObject(input) && Array.isArray(input.keys) && Array.from(input.keys).every(isObject);
}
function isDisjoint(...headers) {
  const parameters = /* @__PURE__ */ new Set();
  for (const header of headers)
    if (header)
      for (const parameter of Object.keys(header)) {
        if (parameters.has(parameter))
          return false;
        parameters.add(parameter);
      }
  return true;
}
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch {
    throw new ErrorClass(`Failed to base64url decode the ${label}`);
  }
}
function encodeBase64url(value, label, ErrorClass) {
  try {
    return encode(value);
  } catch {
    throw new ErrorClass(`The ${label} is not a valid base64url string`);
  }
}
function parseJoseHeader(b64, ErrorClass, message2) {
  let parsed;
  try {
    parsed = JSON.parse(strictDecoder.decode(decode(b64)));
  } catch {
    throw new ErrorClass(message2);
  }
  if (!isObject(parsed))
    throw new ErrorClass(message2);
  return parsed;
}
var JWS_RECOGNIZED = { __proto__: null, b64: true };
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s != "string")))
    throw new TypeError(`"${option}" option must be an array of strings`);
  return algorithms === void 0 ? void 0 : new Set(algorithms);
}
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0)
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  if (!protectedHeader || protectedHeader.crit === void 0)
    return [];
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input != "string" || input.length === 0))
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  const recognized = recognizedOption === void 0 ? recognizedDefault : { __proto__: null, ...recognizedOption, ...recognizedDefault };
  for (const parameter of protectedHeader.crit) {
    if (!(parameter in recognized))
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    if (!Object.hasOwn(joseHeader, parameter) || joseHeader[parameter] === void 0)
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    if (recognized[parameter] && (!Object.hasOwn(protectedHeader, parameter) || protectedHeader[parameter] === void 0))
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
  }
  return protectedHeader.crit;
}
function validateB64(protectedHeader, extensions) {
  if (extensions.includes("b64")) {
    const b64 = protectedHeader.b64;
    if (typeof b64 != "boolean")
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    return b64;
  }
  return true;
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/lib/key.js
var tag = (key) => key[Symbol.toStringTag];
var jwkMatchesOp = (entry, key, usage) => {
  const { alg } = entry;
  if (key.use !== void 0) {
    const expected = usage === "sign" || usage === "verify" ? "sig" : "enc";
    if (key.use !== expected)
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
  }
  if (key.alg !== void 0 && key.alg !== alg)
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  if (Array.isArray(key.key_ops)) {
    const expectedKeyOp = usage === "encrypt" || usage === "decrypt" ? entry.ops?.[usage === "encrypt" ? 0 : 1] : usage;
    if (expectedKeyOp && !key.key_ops.includes(expectedKeyOp))
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
  }
};
async function prepareKey(entry, key, usage) {
  const { alg, secret } = entry, privateKey = usage === "decrypt" || usage === "sign";
  if (secret && key instanceof Uint8Array)
    return key;
  let normalized, keyObject;
  if (isObject(key)) {
    if (normalized = normalizeJwk(key), typeof normalized.kty != "string")
      throw invalidKeyType(alg, key, secret);
    if (!(secret ? normalized.kty === "oct" && typeof normalized.k == "string" : normalized.kty !== "oct" && (privateKey ? normalized.kty === "AKP" && typeof normalized.priv == "string" || typeof normalized.d == "string" : normalized.d === void 0 && normalized.priv === void 0)))
      throw new TypeError(secret ? 'JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present' : `JSON Web Key for this operation must be a ${privateKey ? "private" : "public"} JWK`);
    if (jwkMatchesOp(entry, normalized, usage), normalized.kty === "oct")
      return decode(normalized.k);
    if (!Object.isFrozen(key)) {
      const { key_ops } = key;
      Array.isArray(key_ops) && Object.freeze(key_ops), Object.freeze(key);
    }
  } else {
    if (!isKeyLike(key))
      throw invalidKeyType(alg, key, secret);
    const expectedType = secret ? "secret" : privateKey ? "private" : "public";
    if (key.type !== expectedType && (secret || ["secret", "public", "private"].includes(key.type)))
      throw new TypeError(`${tag(key)} instances must be of type "${expectedType}" for the ${alg} algorithm`);
    if (isCryptoKey(key))
      return key;
    if (keyObject = key, keyObject.type === "secret")
      return keyObject.export();
  }
  cache ||= /* @__PURE__ */ new WeakMap();
  const cacheKey = key;
  let cached = cache.get(cacheKey);
  if (cached?.[alg])
    return cached[alg];
  if (cached || cache.set(cacheKey, cached = {}), keyObject && typeof keyObject.toCryptoKey == "function") {
    const isPublic = keyObject.type === "public", crv = nist[keyObject.asymmetricKeyDetails?.namedCurve], params = entry.resolve?.({ crv, asymmetricKeyType: keyObject.asymmetricKeyType }) ?? entry.subtle;
    return cached[alg] = keyObject.toCryptoKey(params, isPublic, entry.usages[isPublic ? 0 : 1]);
  }
  return normalized ??= keyObject.export({ format: "jwk" }), normalized.alg = alg, cached[alg] = await jwkToKey(entry, normalized);
}
var cache;
var nist = {
  __proto__: null,
  prime256v1: "P-256",
  secp384r1: "P-384",
  secp521r1: "P-521"
};
var isCryptoKey = (key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
};
var isKeyObject = (key) => key?.[Symbol.toStringTag] === "KeyObject";
var isKeyLike = (key) => isCryptoKey(key) || isKeyObject(key);
function message(msg, actual, ...types) {
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else types.length === 2 ? msg += `one of type ${types[0]} or ${types[1]}.` : msg += `of type ${types[0]}.`;
  return actual == null ? msg += ` Received ${actual}` : typeof actual == "function" && actual.name ? msg += ` Received function ${actual.name}` : typeof actual == "object" && actual != null && actual.constructor?.name && (msg += ` Received an instance of ${actual.constructor.name}`), msg;
}
function invalidKeyType(alg, actual, secret) {
  const types = ["CryptoKey", "KeyObject", "JSON Web Key"];
  return secret && types.push("Uint8Array"), new TypeError(message(`Key for the ${alg} algorithm must be `, actual, ...types));
}
var unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage))
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
}
function checkModulusLength(alg, key) {
  const { modulusLength } = key.algorithm;
  if (typeof modulusLength != "number" || modulusLength < 2048)
    throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
}
function checkCryptoKey(key, expected, usage) {
  const algorithm = key.algorithm;
  if (algorithm.name !== expected.name)
    throw unusable(expected.name);
  if (expected.hash && algorithm.hash?.name !== expected.hash)
    throw unusable(expected.hash, "algorithm.hash");
  if (expected.namedCurve && algorithm.namedCurve !== expected.namedCurve)
    throw unusable(expected.namedCurve, "algorithm.namedCurve");
  if (expected.length !== void 0 && algorithm.length !== expected.length)
    throw unusable(expected.length, "algorithm.length");
  checkUsage(key, usage);
}
function snapshotJwk(jwk) {
  return { __proto__: null, ...jwk };
}
function normalizeJwk(jwk) {
  const normalized = snapshotJwk(jwk);
  if (normalized.ext !== void 0 && typeof normalized.ext != "boolean")
    throw new TypeError('"ext" (Extractable) Parameter must be a boolean');
  if (normalized.key_ops !== void 0) {
    const value = normalized.key_ops, keyOps = Array.isArray(value) ? [...value] : void 0;
    if (!keyOps || keyOps.some((operation) => typeof operation != "string") || new Set(keyOps).size !== keyOps.length)
      throw new TypeError('"key_ops" (Key Operations) Parameter must be an array of unique strings');
    normalized.key_ops = keyOps;
  }
  return normalized;
}
async function jwkToKey(entry, jwk, extractable) {
  if (!entry.kty.includes(jwk.kty))
    throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  const algorithm = entry.resolve?.({ kty: jwk.kty, crv: jwk.crv }) ?? entry.subtle, isPrivate = !!(jwk.d || jwk.priv), keyData = { ...jwk, ext: extractable ?? jwk.ext };
  return keyData.kty !== "AKP" && delete keyData.alg, delete keyData.use, crypto.subtle.importKey("jwk", keyData, algorithm, keyData.ext ?? !isPrivate, jwk.key_ops ?? entry.usages[isPrivate ? 1 : 0]);
}
async function rawKey(key, expected, usage, extractable = false) {
  return key instanceof Uint8Array && (key = await crypto.subtle.importKey("raw", key, expected, extractable, [usage])), checkCryptoKey(key, expected, usage), key;
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/lib/key_descriptor.js
function table(entries) {
  const out = { __proto__: null };
  for (const alg in entries)
    out[alg] = { ...entries[alg], alg };
  return out;
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/lib/jws_algorithms.js
var sig = [["verify"], ["sign"]];
function hmac(bits) {
  const subtle = { name: "HMAC", hash: `SHA-${bits}` };
  return { kty: ["oct"], secret: true, subtle, signing: subtle, usages: sig };
}
function rsa(bits, saltLength) {
  const subtle = { name: saltLength ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", hash: `SHA-${bits}` };
  return {
    kty: ["RSA"],
    subtle,
    signing: saltLength ? { ...subtle, saltLength } : subtle,
    usages: sig,
    minRsaBits: 2048
  };
}
function ecdsa(crv, bits) {
  return {
    kty: ["EC"],
    crv,
    subtle: { name: "ECDSA", namedCurve: crv },
    signing: { name: "ECDSA", hash: `SHA-${bits}` },
    usages: sig
  };
}
function eddsa() {
  const subtle = { name: "Ed25519" };
  return {
    kty: ["OKP"],
    crv: "Ed25519",
    subtle,
    signing: subtle,
    usages: sig
  };
}
function mldsa(bits) {
  const subtle = { name: `ML-DSA-${bits}` };
  return {
    kty: ["AKP"],
    subtle,
    signing: subtle,
    usages: sig
  };
}
var JWS = table({
  HS256: hmac(256),
  HS384: hmac(384),
  HS512: hmac(512),
  RS256: rsa(256),
  RS384: rsa(384),
  RS512: rsa(512),
  PS256: rsa(256, 32),
  PS384: rsa(384, 48),
  PS512: rsa(512, 64),
  ES256: ecdsa("P-256", 256),
  ES384: ecdsa("P-384", 384),
  ES512: ecdsa("P-521", 512),
  EdDSA: eddsa(),
  Ed25519: eddsa(),
  "ML-DSA-44": mldsa(44),
  "ML-DSA-65": mldsa(65),
  "ML-DSA-87": mldsa(87)
});
function jwsAlgorithm(alg) {
  const entry = typeof alg == "string" ? JWS[alg] : void 0;
  if (!entry)
    throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  return entry;
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/lib/jws_verify.js
function prepareVerify(options) {
  return [options && validateAlgorithms("algorithms", options.algorithms), options?.crit];
}
function parseProtectedHeader(encodedProtected) {
  return encodedProtected === void 0 ? {} : parseJoseHeader(encodedProtected, JWSInvalid, "JWS Protected Header is invalid");
}
function encodeCompactUnencodedPayload(payload) {
  try {
    return encode(payload);
  } catch {
    throw new JWSInvalid("JWS Compact Serialization payload must use only ASCII characters");
  }
}
async function verifySignature(jws, shared, key, encodeUnencodedPayload, parsedProtected) {
  const { protected: encodedProtected, header, payload: inputPayload } = jws, parsedProt = parsedProtected ?? parseProtectedHeader(encodedProtected);
  if (!isDisjoint(parsedProt, header))
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  const joseHeader = { ...parsedProt, ...header }, b64 = validateB64(parsedProt, validateCrit(JWSInvalid, JWS_RECOGNIZED, shared[1], parsedProt, joseHeader)), { alg } = joseHeader;
  if (typeof alg != "string" || !alg)
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  if (shared[0] && !shared[0].has(alg))
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  if (b64) {
    if (typeof inputPayload != "string")
      throw new JWSInvalid("JWS Payload must be a string");
  } else if (typeof inputPayload != "string" && !(inputPayload instanceof Uint8Array))
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  const signingPayload = b64 || typeof inputPayload != "string" ? inputPayload : encodeUnencodedPayload(inputPayload);
  let resolvedKey = false;
  typeof key == "function" && (key = await key(parsedProt, jws), resolvedKey = true);
  const entry = jwsAlgorithm(alg), data = concat(encodedProtected !== void 0 ? encode(encodedProtected) : new Uint8Array(), encode("."), typeof signingPayload == "string" ? shared[2] ??= encodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload), signature = decodeBase64url(jws.signature, "signature", JWSInvalid), k = await prepareKey(entry, key, "verify"), cryptoKey = await rawKey(k, entry.subtle, "verify");
  entry.minRsaBits && checkModulusLength(entry.alg, cryptoKey);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(entry.signing, cryptoKey, signature, data);
  } catch {
  }
  if (!verified)
    throw new JWSSignatureVerificationFailed();
  const result = { payload: typeof signingPayload == "string" ? decodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload };
  return encodedProtected !== void 0 && (result.protectedHeader = parsedProt), header !== void 0 && (result.unprotectedHeader = header), resolvedKey ? [{ ...result, key: k }, b64] : [result, b64];
}
async function verifyCompact(jws, shared, key) {
  if (jws instanceof Uint8Array && (jws = decoder.decode(jws)), typeof jws != "string")
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3)
    throw new JWSInvalid("Invalid Compact JWS");
  return verifySignature({ payload, protected: protectedHeader, signature }, shared, key, encodeCompactUnencodedPayload);
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/lib/jwt_claims_set.js
var epoch = (date) => Math.floor(date.getTime() / 1e3);
var multipliers = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31557600
};
var REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
var checkFailed = "check_failed";
function invalidDuration() {
  throw new TypeError("Invalid time period format");
}
function secs(str) {
  typeof str != "string" && invalidDuration();
  const matched = REGEX.exec(str);
  (!matched || matched[4] && matched[1]) && invalidDuration();
  const value = parseFloat(matched[2]), numericDate2 = Math.round(value * multipliers[matched[3][0].toLowerCase()]);
  return Number.isFinite(numericDate2) || invalidDuration(), matched[1] === "-" || matched[4] === "ago" ? -numericDate2 : numericDate2;
}
function validateInput(label, input) {
  if (!Number.isFinite(input))
    throw new TypeError(`Invalid ${label} input`);
  return input;
}
var normalizeTyp = (value) => {
  const normalized = value.toLowerCase();
  return value.includes("/") ? normalized : `application/${normalized}`;
};
var checkAudiencePresence = (audPayload, audOption) => typeof audPayload == "string" ? audOption.includes(audPayload) : Array.isArray(audPayload) ? audOption.some((aud) => audPayload.includes(aud)) : false;
function validateNumericDate(payload, claim, required = false) {
  const value = payload[claim];
  if (!(value === void 0 && !required)) {
    if (typeof value != "number")
      throw new JWTClaimValidationFailed(`"${claim}" claim must be a number`, payload, claim, "invalid");
    return value;
  }
}
function unexpectedClaim(payload, claim) {
  throw new JWTClaimValidationFailed(`unexpected "${claim}" claim value`, payload, claim, checkFailed);
}
function validateClaimsSet(protectedHeader, encodedPayload, options = {}) {
  let payload;
  try {
    payload = JSON.parse(strictDecoder.decode(encodedPayload));
  } catch {
  }
  if (!isObject(payload))
    throw new JWTInvalid("JWT Claims Set must be a top-level JSON object");
  const { typ } = options;
  if (typ !== void 0 && (typeof protectedHeader.typ != "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ)))
    throw new JWTClaimValidationFailed('unexpected "typ" JWT header value', payload, "typ", checkFailed);
  const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options, presenceCheck = [...requiredClaims];
  maxTokenAge !== void 0 && presenceCheck.push("iat"), audience !== void 0 && presenceCheck.push("aud"), subject !== void 0 && presenceCheck.push("sub"), issuer !== void 0 && presenceCheck.push("iss");
  for (const claim of new Set(presenceCheck.reverse()))
    if (!Object.hasOwn(payload, claim))
      throw new JWTClaimValidationFailed(`missing required "${claim}" claim`, payload, claim, "missing");
  issuer !== void 0 && !(Array.isArray(issuer) ? issuer : [issuer]).includes(payload.iss) && unexpectedClaim(payload, "iss"), subject !== void 0 && payload.sub !== subject && unexpectedClaim(payload, "sub"), audience !== void 0 && !checkAudiencePresence(payload.aud, typeof audience == "string" ? [audience] : audience) && unexpectedClaim(payload, "aud");
  const { clockTolerance } = options;
  let tolerance = 0;
  if (typeof clockTolerance == "string")
    tolerance = secs(clockTolerance);
  else if (clockTolerance !== void 0) {
    if (typeof clockTolerance != "number")
      throw new TypeError("Invalid clockTolerance option type");
    tolerance = clockTolerance;
  }
  validateInput("clockTolerance option", tolerance);
  const { currentDate } = options, now = validateInput("currentDate option", epoch(currentDate === void 0 ? /* @__PURE__ */ new Date() : currentDate)), iat = validateNumericDate(payload, "iat", maxTokenAge !== void 0), nbf = validateNumericDate(payload, "nbf");
  if (nbf !== void 0 && nbf > now + tolerance)
    throw new JWTClaimValidationFailed('"nbf" claim timestamp check failed', payload, "nbf", checkFailed);
  const exp = validateNumericDate(payload, "exp");
  if (exp !== void 0 && exp <= now - tolerance)
    throw new JWTExpired('"exp" claim timestamp check failed', payload, "exp", checkFailed);
  if (maxTokenAge !== void 0) {
    const age = now - iat, max = validateInput("maxTokenAge option", typeof maxTokenAge == "number" ? maxTokenAge : secs(maxTokenAge));
    if (age - tolerance > max)
      throw new JWTExpired('"iat" claim timestamp check failed (too far in the past)', payload, "iat", checkFailed);
    if (age < -tolerance)
      throw new JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', payload, "iat", checkFailed);
  }
  return payload;
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/jwt/verify.js
async function jwtVerify(jwt, key, options) {
  const [verified, b64] = await verifyCompact(jwt, prepareVerify(options), key);
  if (!b64)
    throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
  const payload = validateClaimsSet(verified.protectedHeader, verified.payload, options);
  return { ...verified, payload };
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/jwks/local.js
function isUsableJWK(jwk, entry, alg, kid) {
  const { kty, key_ops: keyOps, ext, kid: jwkKid, alg: jwkAlg, use, crv } = jwk;
  return (ext === void 0 || typeof ext == "boolean") && (keyOps === void 0 || Array.isArray(keyOps) && keyOps.every((operation, index) => typeof operation == "string" && keyOps.indexOf(operation) === index) && keyOps.includes("verify")) && entry.kty.includes(kty) && (kid === void 0 || typeof kid == "string" && kid === jwkKid) && (jwkAlg === void 0 ? kty !== "AKP" : alg === jwkAlg) && (use === void 0 || use === "sig") && (!entry.crv || crv === entry.crv);
}
async function importWithAlgCache(cache2, jwk, entry) {
  const cached = cache2.get(jwk) || cache2.set(jwk, {}).get(jwk), { alg } = entry;
  if (cached[alg] === void 0) {
    const pending = jwkToKey(entry, jwk, true).then((key) => {
      if (key.type !== "public")
        throw new JWKSInvalid("JSON Web Key Set members must be public keys");
      return cached[alg] = key, key;
    }).catch((error) => {
      throw cached[alg] === pending && delete cached[alg], error;
    });
    cached[alg] = pending;
  }
  return cached[alg];
}
function createLocalJWKSet(jwks) {
  let snapshot;
  try {
    snapshot = structuredClone(jwks);
  } catch {
  }
  if (!isJwkSet(snapshot))
    throw new JWKSInvalid("JSON Web Key Set malformed");
  const metadata = snapshot.keys.map((jwk) => {
    const normalized = snapshotJwk(jwk);
    return Array.isArray(normalized.key_ops) && (normalized.key_ops = [...normalized.key_ops]), normalized;
  }), cached = /* @__PURE__ */ new WeakMap();
  return Object.defineProperty(async (protectedHeader, token) => {
    const { alg, kid } = { ...protectedHeader, ...token?.header }, entry = typeof alg == "string" ? JWS[alg] : void 0;
    if (!entry || entry.secret)
      throw new JOSENotSupported('Unsupported "alg" value for a JSON Web Key Set');
    const candidates = snapshot.keys.filter((_, index) => isUsableJWK(metadata[index], entry, alg, kid)), { 0: jwk, length } = candidates;
    if (!length)
      throw new JWKSNoMatchingKey();
    if (length !== 1) {
      const error = new JWKSMultipleMatchingKeys();
      throw error[Symbol.asyncIterator] = async function* () {
        for (const jwk2 of candidates)
          try {
            yield await importWithAlgCache(cached, jwk2, entry);
          } catch {
          }
      }, error;
    }
    return importWithAlgCache(cached, jwk, entry);
  }, "jwks", {
    value: () => structuredClone(snapshot)
  });
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/jwks/remote.js
function isCloudflareWorkers() {
  return typeof WebSocketPair < "u" || typeof navigator < "u" && navigator.userAgent === "Cloudflare-Workers" || typeof EdgeRuntime < "u" && EdgeRuntime === "vercel";
}
var USER_AGENT;
(typeof navigator > "u" || !navigator.userAgent?.startsWith?.("Mozilla/5.0 ")) && (USER_AGENT = "jose/v6.2.12");
var customFetch = /* @__PURE__ */ Symbol();
async function fetchJwks(url, headers, signal, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    signal,
    redirect: "manual",
    headers
  }).catch((err) => {
    throw err.name === "TimeoutError" ? new JWKSTimeout() : err;
  });
  if (response.status !== 200)
    throw new JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
  try {
    return await response.json();
  } catch {
    throw new JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON");
  }
}
var jwksCache = /* @__PURE__ */ Symbol();
function isFreshFor(timestamp, duration) {
  return Number.isFinite(timestamp) && Date.now() < timestamp + duration;
}
function validateDuration(value, fallback, option) {
  if (Number.isNaN(value))
    throw new TypeError(`"${option}" option must not be NaN`);
  return typeof value == "number" ? value : fallback;
}
function createRemoteJWKSet(url, options) {
  if (!(url instanceof URL))
    throw new TypeError("url must be an instance of URL");
  const href = new URL(url.href).href, opts = options ?? {}, timeoutOption = opts.timeoutDuration;
  if (typeof timeoutOption == "number" && (!Number.isInteger(timeoutOption) || timeoutOption < 0))
    throw new TypeError('"timeoutDuration" option must be a non-negative integer');
  const timeoutDuration = typeof timeoutOption == "number" ? timeoutOption : 5e3, cooldownDuration = validateDuration(opts.cooldownDuration, 3e4, "cooldownDuration"), cacheMaxAge = validateDuration(opts.cacheMaxAge, 6e5, "cacheMaxAge"), headers = new Headers(opts.headers);
  USER_AGENT && !headers.has("User-Agent") && headers.set("User-Agent", USER_AGENT), headers.has("accept") || headers.set("accept", "application/json, application/jwk-set+json");
  const fetchImpl = opts[customFetch], cache2 = opts[jwksCache];
  let jwksTimestamp, pendingFetch, reloadSequence = 0, appliedSequence = 0, local;
  if (cache2 && typeof cache2 == "object") {
    const { uat, jwks } = cache2;
    isFreshFor(uat, cacheMaxAge) && isJwkSet(jwks) && (jwksTimestamp = uat, local = createLocalJWKSet(jwks));
  }
  const reload = async () => {
    if (pendingFetch && isCloudflareWorkers() && (pendingFetch = void 0), !pendingFetch) {
      const sequence = ++reloadSequence, current = pendingFetch = fetchJwks(href, headers, AbortSignal.timeout(timeoutDuration), fetchImpl).then((json) => {
        const next = createLocalJWKSet(json);
        if (sequence <= appliedSequence)
          return;
        local = next;
        const updatedAt = Date.now();
        cache2 && (cache2.uat = updatedAt, cache2.jwks = json), jwksTimestamp = updatedAt, appliedSequence = sequence;
      }).finally(() => {
        pendingFetch === current && (pendingFetch = void 0);
      });
    }
    await pendingFetch;
  };
  return Object.defineProperties(async (protectedHeader, token) => {
    (!local || !isFreshFor(jwksTimestamp, cacheMaxAge)) && await reload();
    try {
      return await local(protectedHeader, token);
    } catch (err) {
      if (err instanceof JWKSNoMatchingKey && !isFreshFor(jwksTimestamp, cooldownDuration))
        return await reload(), local(protectedHeader, token);
      throw err;
    }
  }, {
    coolingDown: {
      get: () => isFreshFor(jwksTimestamp, cooldownDuration),
      enumerable: true
    },
    fresh: {
      get: () => isFreshFor(jwksTimestamp, cacheMaxAge),
      enumerable: true
    },
    reload: {
      value: reload,
      enumerable: true
    },
    reloading: {
      get: () => !!pendingFetch,
      enumerable: true
    },
    jwks: {
      value: () => local?.jwks(),
      enumerable: true
    }
  });
}

// ../../../witch-best-consolidation-20261001/candidate/node_modules/jose/dist/webapi/util/decode_protected_header.js
function decodeProtectedHeader(token) {
  let protectedB64u;
  if (typeof token == "string") {
    const parts = token.split(".");
    (parts.length === 3 || parts.length === 5) && ([protectedB64u] = parts);
  } else if (typeof token == "object" && token)
    if ("protected" in token)
      protectedB64u = token.protected;
    else
      throw new TypeError("Token does not contain a Protected Header");
  const invalid2 = "Invalid Token or Protected Header formatting";
  if (typeof protectedB64u != "string" || !protectedB64u)
    throw new TypeError(invalid2);
  return parseJoseHeader(protectedB64u, TypeError, invalid2);
}

// src/principal.mjs
var DEFAULT_MAX_TOKEN_REMAINING_SECONDS = 24 * 60 * 60;
var DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
var DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
var DEFAULT_IAT_FUTURE_SKEW_SECONDS = 60;
var ACCESS_HEADER = "cf-access-jwt-assertion";
var ACCESS_COOKIE = "CF_Authorization";
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function ownerSegmentOf(hex) {
  return String(hex).slice(0, 32);
}
async function principalHexFrom(issuer, sub) {
  return sha256Hex(`${issuer}
${sub}`);
}
async function principalSegment(issuer, sub) {
  return ownerSegmentOf(await principalHexFrom(issuer, sub));
}
function makeJwksResolver(opts = {}) {
  const { jwksUri, timeoutMs = 5e3, cooldownMs = 3e4 } = opts;
  return createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: timeoutMs,
    cooldownDuration: cooldownMs
  });
}
var RESOLVER_CACHE = /* @__PURE__ */ new Map();
function resolverFor(teamDomain, opts) {
  const uri = opts.jwksUri || `${teamDomain}/cdn-cgi/access/certs`;
  const key = `${uri}|${opts.timeoutMs ?? 5e3}|${opts.cooldownMs ?? 3e4}`;
  let r = RESOLVER_CACHE.get(key);
  if (!r) {
    r = makeJwksResolver({ ...opts, jwksUri: uri });
    RESOLVER_CACHE.set(key, r);
  }
  return r;
}
async function verifyPrincipal(token, env, opts = {}) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token" };
  }
  const teamDomain = env && typeof env.TEAM_DOMAIN === "string" ? env.TEAM_DOMAIN.trim() : "";
  const aud = env && typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  if (!teamDomain || !aud) {
    return { ok: false, reason: "config_missing", status: 503 };
  }
  const issuer = teamDomain.replace(/\/+$/, "");
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
  if (header.alg !== "RS256") {
    return { ok: false, reason: "bad_algorithm" };
  }
  if (header.typ !== void 0 && header.typ !== "JWT") {
    return { ok: false, reason: "bad_typ" };
  }
  const keySet = opts.keySet || resolverFor(issuer, opts);
  const now = typeof opts.now === "number" ? opts.now : Math.floor(Date.now() / 1e3);
  const maxRemaining = opts.maxRemainingSeconds ?? DEFAULT_MAX_TOKEN_REMAINING_SECONDS;
  const maxLifetime = opts.maxLifetimeSeconds ?? DEFAULT_MAX_TOKEN_LIFETIME_SECONDS;
  const skew = opts.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  let payload;
  try {
    const res = await jwtVerify(token, keySet, {
      issuer,
      audience: aud,
      algorithms: ["RS256"],
      clockTolerance: skew,
      currentDate: new Date(now * 1e3)
    });
    payload = res.payload;
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: "exp_missing" };
  }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    return { ok: false, reason: "iat_missing" };
  }
  if (payload.exp <= payload.iat) {
    return { ok: false, reason: "lifetime_invalid" };
  }
  if (payload.exp <= now - skew) return { ok: false, reason: "expired" };
  if (payload.exp > now + maxRemaining + skew) return { ok: false, reason: "exp_unbounded" };
  if (payload.exp - payload.iat > maxLifetime + skew) {
    return { ok: false, reason: "lifetime_unbounded" };
  }
  const iatSkew = opts.iatFutureSkewSeconds ?? DEFAULT_IAT_FUTURE_SKEW_SECONDS;
  if (payload.iat > now + iatSkew) return { ok: false, reason: "iat_future" };
  if (payload.type !== void 0 && payload.type !== "app") {
    return { ok: false, reason: "bad_type" };
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return { ok: false, reason: "sub_missing" };
  }
  const principalHex = await principalHexFrom(issuer, payload.sub);
  const segment = ownerSegmentOf(principalHex);
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : void 0;
  return {
    ok: true,
    principal: principalHex,
    // full 64-hex stable id
    principalHex,
    segment,
    // 32-hex R2 namespace segment
    sub: payload.sub,
    issuer,
    exp: payload.exp,
    ...email ? { email } : {}
  };
}
function readCookie(request, name) {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}
function accessAssertionFrom(request) {
  const h = request.headers.get(ACCESS_HEADER);
  if (h && h.length) return { token: h, source: "header" };
  const c = readCookie(request, ACCESS_COOKIE);
  if (c && c.length) return { token: c, source: "cookie" };
  return null;
}

// src/library.mjs
var MAX_LIST_LIMIT = 100;
var DEFAULT_LIST_LIMIT = 50;
var MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
var MAX_MIRROR_BYTES = 64 * 1024 * 1024;
var EXT_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg"
};
function extForContentType(contentType) {
  return EXT_BY_TYPE[String(contentType || "").toLowerCase()] || null;
}
function isLibraryKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 300) return false;
  if (key.includes("..") || key.includes("\0")) return false;
  const parts = key.split("/");
  if (parts.length !== 2) return false;
  const [seg, name] = parts;
  if (!/^p_[0-9a-f]{32}$/.test(seg)) return false;
  if (!/^[A-Za-z0-9_-]{1,120}\.[A-Za-z0-9]{1,8}$/.test(name)) return false;
  return true;
}
function segmentOfLibraryKey(key) {
  return isLibraryKey(key) ? key.slice(0, key.indexOf("/")) : null;
}
function namespaceFor(principalSegment2) {
  const hex = String(principalSegment2).replace(/^p_/, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("bad_principal_segment");
  return `p_${hex}`;
}
function isLegacyKey(key) {
  return typeof key === "string" && key.length > 0 && !isLibraryKey(key);
}
function libraryKeyFor(principalSegment2, contentType, uuid) {
  const ext = extForContentType(contentType);
  if (!ext) throw new Error("unsupported_content_type");
  if (!/^p_[0-9a-f]{32}$/.test(principalSegment2)) throw new Error("bad_principal_segment");
  return `${principalSegment2}/${uuid}.${ext}`;
}
async function listOwned(media, principalSegment2, { limit, cursor } = {}) {
  const want = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const prefix = `${principalSegment2}/`;
  const opts = { prefix, limit: want };
  if (cursor) opts.cursor = cursor;
  const out = await media.list(opts);
  const objects = (out.objects || []).filter((o) => isLibraryKey(o.key) && segmentOfLibraryKey(o.key) === principalSegment2);
  return {
    keys: objects.map((o) => o.key),
    truncated: !!out.truncated,
    cursor: out.truncated ? out.cursor || null : null
  };
}
function authorizeKey(key, principalSegment2) {
  if (isLegacyKey(key)) return { allowed: false, reason: "legacy_or_unknown_key" };
  if (!isLibraryKey(key)) return { allowed: false, reason: "malformed_key" };
  const seg = segmentOfLibraryKey(key);
  if (seg !== principalSegment2) return { allowed: false, reason: "foreign_key" };
  return { allowed: true, reason: "ok", key };
}
function jsonNoStore(body, status = 200, extra = {}, head = false) {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private,no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra
    }
  });
}
function libraryDenied() {
  return jsonNoStore({ error: "Not found" }, 404);
}
function methodNotAllowed() {
  return jsonNoStore({ error: "Method not allowed" }, 405, { Allow: "GET, POST, DELETE" });
}
async function handleList(media, principalSegment2, url, method = "GET") {
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") || void 0;
  const { keys, truncated, cursor: next } = await listOwned(media, principalSegment2, { limit, cursor });
  const payload = {
    items: keys.map((key) => ({ key, url: "/api/library/object/" + key })),
    truncated,
    cursor: next
  };
  return jsonNoStore(payload, 200, {}, method === "HEAD");
}
async function handleRead(media, key, principalSegment2, method = "GET") {
  const decision = authorizeKey(key, principalSegment2);
  if (!decision.allowed) return libraryDenied();
  const obj = await media.get(key);
  if (!obj) return libraryDenied();
  const metaOwner = obj.customMetadata && obj.customMetadata.owner;
  if (metaOwner && metaOwner !== principalSegment2) return libraryDenied();
  const contentType = obj.httpMetadata && obj.httpMetadata.contentType || "application/octet-stream";
  return new Response(method === "HEAD" ? null : obj.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(obj.size ?? ""),
      "Cache-Control": "private,no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      Vary: "Cookie"
    }
  });
}
async function handleUpload(media, principalSegment2, request) {
  const contentType = request.headers.get("content-type") || "";
  const ext = extForContentType(contentType.split(";")[0].trim());
  if (!ext) return jsonNoStore({ error: "unsupported_content_type" }, 415);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared && declared > MAX_UPLOAD_BYTES) return jsonNoStore({ error: "too_large" }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return jsonNoStore({ error: "too_large" }, 413);
  const uuid = crypto.randomUUID();
  const key = libraryKeyFor(principalSegment2, contentType.split(";")[0].trim(), uuid);
  await media.put(key, bytes, {
    httpMetadata: { contentType: contentType.split(";")[0].trim() },
    customMetadata: {
      owner: principalSegment2,
      job: "",
      source: "upload",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  });
  return jsonNoStore({ key, url: "/api/library/object/" + key }, 201);
}
async function handleDelete(media, key, principalSegment2) {
  const decision = authorizeKey(key, principalSegment2);
  if (!decision.allowed) return libraryDenied();
  const obj = await media.get(key);
  if (!obj) return libraryDenied();
  const metaOwner = obj.customMetadata && obj.customMetadata.owner;
  if (metaOwner && metaOwner !== principalSegment2) return libraryDenied();
  await media.delete(key);
  return jsonNoStore({ ok: true, key });
}
async function storeMirrored(media, principalSegment2, { bytes, contentType, job }) {
  const ext = extForContentType(contentType);
  if (!ext) throw new Error("unsupported_content_type");
  if (bytes.byteLength > MAX_MIRROR_BYTES) throw new Error("mirror_too_large");
  const uuid = crypto.randomUUID();
  const key = libraryKeyFor(principalSegment2, contentType, uuid);
  await media.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      owner: principalSegment2,
      job: String(job || "").slice(0, 64),
      source: "mirror",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  });
  return key;
}
async function readMirrorReceipt(media, principalSegment2, job) {
  const key = `${principalSegment2}/.receipts/${job}.json`;
  const obj = await media.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}
async function writeMirrorReceipt(media, principalSegment2, job, receipt) {
  const key = `${principalSegment2}/.receipts/${job}.json`;
  await media.put(key, JSON.stringify(receipt), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { owner: principalSegment2, job: String(job).slice(0, 64), source: "receipt" }
  });
  return key;
}

// src/hosted-registry.mjs
var REGISTRY_PREFIX = "registry/";
var ID_RE = /^[a-z0-9:_-]{1,120}$/i;
function isRegistryId(requestId) {
  return typeof requestId === "string" && ID_RE.test(requestId);
}
function registryKey(requestId) {
  return `${REGISTRY_PREFIX}${requestId}.json`;
}
async function registerRequest(media, { requestId, subject, provider, now = 0 }) {
  if (!isRegistryId(requestId)) throw new Error("bad_request_id");
  if (!/^p_[0-9a-f]{32}$/.test(subject)) throw new Error("bad_subject");
  const existing = await media.get(registryKey(requestId));
  if (existing) {
    const row2 = await existing.json().catch(() => null);
    if (row2 && row2.subject !== subject) throw new Error("request_id_already_owned");
    return row2;
  }
  const row = {
    subject,
    provider: String(provider || ""),
    createdAt: new Date(now || Date.now()).toISOString(),
    state: "submitted"
  };
  await media.put(registryKey(requestId), JSON.stringify(row), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { owner: subject, source: "registry", job: requestId }
  });
  return row;
}
async function authorizeStatus(media, requestId, subject) {
  if (!isRegistryId(requestId)) return { ok: false, reason: "bad_request_id" };
  const obj = await media.get(registryKey(requestId));
  if (!obj) return { ok: false, reason: "unknown_request" };
  const row = await obj.json().catch(() => null);
  if (!row || typeof row.subject !== "string") return { ok: false, reason: "unknown_request" };
  if (row.subject !== subject) return { ok: false, reason: "foreign_request" };
  return { ok: true, row };
}
async function updateRegistryState(media, requestId, patch) {
  const obj = await media.get(registryKey(requestId));
  if (!obj) return null;
  const row = await obj.json().catch(() => null) || {};
  const next = { ...row, ...patch };
  await media.put(registryKey(requestId), JSON.stringify(next), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { owner: String(row.subject || ""), source: "registry", job: requestId }
  });
  return next;
}
async function resolveOutputUrl(media, requestId, subject) {
  const auth = await authorizeStatus(media, requestId, subject);
  if (!auth.ok) return null;
  const row = auth.row;
  if (typeof row.outputUrl !== "string" || row.outputUrl.length === 0) return null;
  return { url: row.outputUrl, contentType: typeof row.outputContentType === "string" ? row.outputContentType : "" };
}
async function partitionStatusIds(media, requestIds, subject) {
  const decisions = [];
  for (const requestId of requestIds) {
    const d = await authorizeStatus(media, requestId, subject);
    decisions.push({ requestId, allowed: d.ok, reason: d.ok ? "ok" : d.reason, row: d.row });
  }
  return decisions;
}

// src/mirror.mjs
var DEFAULT_MIRROR_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_REDIRECTS = 3;
var IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
function isBannedLiteralHost(host) {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (IPV4_RE.test(h)) return true;
  if (h.includes(":")) return true;
  if (!h.includes(".")) return true;
  return false;
}
function isValidAllowlistEntry(entry) {
  if (typeof entry !== "string") return false;
  let e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.includes("*")) return false;
  const suffixForm = e.startsWith(".");
  if (suffixForm) e = e.slice(1);
  if (!e.includes(".")) return false;
  if (e.startsWith(".") || e.endsWith(".") || e.includes("..")) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(e)) return false;
  if (isBannedLiteralHost(e)) return false;
  return true;
}
function checkAllowlisted(rawUrl, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { ok: false, reason: "allowlist_unconfigured" };
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "url_credentials" };
  if (url.port && url.port !== "443") return { ok: false, reason: "bad_port" };
  const host = url.hostname.toLowerCase();
  if (isBannedLiteralHost(host)) return { ok: false, reason: "literal_host" };
  const allowed = allowlist.filter(isValidAllowlistEntry).map((h) => h.trim().toLowerCase());
  const ok = allowed.some((entry) => {
    if (entry.startsWith(".")) {
      const suffix = entry.slice(1);
      return host === suffix || host.endsWith("." + suffix);
    }
    return host === entry;
  });
  if (!ok) return { ok: false, reason: "host_not_allowed" };
  return { ok: true, url };
}
async function allowlistedFetch(rawUrl, allowlist, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MIRROR_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || fetch;
  let localController = null;
  let localTimer = null;
  let signal = opts.signal;
  if (!signal) {
    localController = new AbortController();
    signal = localController.signal;
    localTimer = setTimeout(() => localController.abort(), timeoutMs);
  }
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = checkAllowlisted(current, allowlist);
      if (!check.ok) return { ok: false, reason: check.reason, status: 502 };
      const res = await fetchImpl(check.url.toString(), {
        redirect: "manual",
        signal,
        headers: { Accept: "application/octet-stream,image/*,video/*" }
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        try {
          await res.body?.cancel();
        } catch {
        }
        if (!loc) return { ok: false, reason: "redirect_without_location", status: 502 };
        current = new URL(loc, check.url).toString();
        if (hop === maxRedirects) return { ok: false, reason: "too_many_redirects", status: 502 };
        continue;
      }
      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
        }
        return { ok: false, reason: "upstream_status", status: 502 };
      }
      return { ok: true, res };
    }
    return { ok: false, reason: "too_many_redirects", status: 502 };
  } catch (e) {
    const reason = e && e.name === "AbortError" ? "timeout" : "fetch_failed";
    return { ok: false, reason, status: 502 };
  } finally {
    if (localTimer) clearTimeout(localTimer);
  }
}
async function readBounded(res, maxBytes = MAX_MIRROR_BYTES, opts = {}) {
  const signal = opts.signal;
  if (signal && signal.aborted) {
    try {
      await res.body?.cancel();
    } catch {
    }
    return { ok: false, reason: "timeout" };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      reader.cancel();
    } catch {
    }
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (aborted) return { ok: false, reason: "timeout" };
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
        }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch (e) {
    const reason = aborted || e && e.name === "AbortError" ? "timeout" : "fetch_failed";
    return { ok: false, reason };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, bytes: out };
}
async function mirrorOnce(media, principalSegment2, { upstreamUrl, contentType, job }, opts = {}) {
  if (job) {
    const receipt = await readMirrorReceipt(media, principalSegment2, job);
    if (receipt && receipt.key && receipt.owner === principalSegment2) {
      return { ok: true, key: receipt.key, url: "/api/library/object/" + receipt.key, cached: true };
    }
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MIRROR_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetched = await allowlistedFetch(upstreamUrl, opts.allowlist, { ...opts, signal: controller.signal });
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    const read = await readBounded(fetched.res, opts.maxBytes ?? MAX_MIRROR_BYTES, { signal: controller.signal });
    if (!read.ok) return { ok: false, reason: read.reason };
    const ct = contentType || fetched.res.headers.get("content-type") || "application/octet-stream";
    const key = await storeMirrored(media, principalSegment2, {
      bytes: read.bytes,
      contentType: String(ct).split(";")[0].trim(),
      job
    });
    if (job) {
      await writeMirrorReceipt(media, principalSegment2, job, {
        key,
        owner: principalSegment2,
        job,
        mirroredAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    return { ok: true, key, url: "/api/library/object/" + key, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

// src/session-bind.mjs
var SESSION_ENVELOPE_VERSION = 1;
function buildSessionEnvelope({ principalSegment: principalSegment2, provider, credential, issuedAt = 0 }) {
  if (!/^p_[0-9a-f]{32}$/.test(principalSegment2)) throw new Error("bad_principal_segment");
  return {
    v: SESSION_ENVELOPE_VERSION,
    principal: principalSegment2,
    provider: String(provider || ""),
    issuedAt: new Date(issuedAt || Date.now()).toISOString(),
    credential
    // sealed by the caller with SESSION_SECRET; opaque here
  };
}
function sessionMatchesPrincipal(envelope, currentSegment) {
  if (!envelope || typeof envelope !== "object") return { ok: false, reason: "no_session" };
  if (envelope.v !== SESSION_ENVELOPE_VERSION) return { ok: false, reason: "bad_version" };
  if (typeof envelope.principal !== "string" || !/^p_[0-9a-f]{32}$/.test(envelope.principal)) {
    return { ok: false, reason: "unbound_session" };
  }
  if (envelope.principal !== currentSegment) return { ok: false, reason: "principal_mismatch" };
  return { ok: true };
}
function historyKeyFor(principalSegment2) {
  return `openhiggsfield.history.v1::${principalSegment2}`;
}
function localKeysToClear(principalSegment2) {
  return [
    historyKeyFor(principalSegment2),
    `openhiggsfield.active.v1::${principalSegment2}`,
    `witchcraft.gallery.favorites.v1::${principalSegment2}`,
    `witchcraft.gallery.mine.v1::${principalSegment2}`
  ];
}
function makeEpochGuard() {
  let epoch2 = 0;
  let principal = null;
  return {
    bind(principalSegment2) {
      principal = principalSegment2;
      epoch2 += 1;
      return epoch2;
    },
    /** Capture a token for an async request started now. */
    capture() {
      return { epoch: epoch2, principal };
    },
    /** True if the captured token is still valid for the current identity. */
    isCurrent(token) {
      return !!token && token.epoch === epoch2 && token.principal === principal;
    },
    bump() {
      epoch2 += 1;
      principal = null;
    }
  };
}
export {
  accessAssertionFrom,
  authorizeKey,
  authorizeStatus,
  buildSessionEnvelope,
  checkAllowlisted,
  handleDelete,
  handleList,
  handleRead,
  handleUpload,
  historyKeyFor,
  isLegacyKey,
  isLibraryKey,
  isValidAllowlistEntry,
  jsonNoStore,
  libraryDenied,
  listOwned,
  localKeysToClear,
  makeEpochGuard,
  methodNotAllowed,
  mirrorOnce,
  namespaceFor,
  partitionStatusIds,
  principalHexFrom,
  principalSegment,
  registerRequest,
  resolveOutputUrl,
  sessionMatchesPrincipal,
  storeMirrored,
  updateRegistryState,
  verifyPrincipal
};
