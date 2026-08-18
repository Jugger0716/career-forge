// scripts/lib/schema-validate.mjs
//
// 의존성 0 자작 JSON Schema 검증 유틸. ajv 등 외부 라이브러리를 쓰지 않는다.
//
// 지원 키워드(명시 — 이 목록 밖 키워드를 스키마에서 만나면 조용히 통과시키지
// 않고 SCHEMA_UNSUPPORTED_KEYWORD 경고를 낸다. scanUnsupportedKeywords 참조):
//   구조: type, properties, additionalProperties(불리언만), required,
//         items, $ref($defs 내부 참조만), $defs, allOf, oneOf, anyOf,
//         if/then/else
//   제약: enum, const, pattern, minLength, maxLength, minimum, maximum,
//         minItems, maxItems, format(date/date-time/email/uri만 형식 검사,
//         그 외 format 값은 검사 없이 통과)
//   메타(검증에 관여하지 않음): $schema, $id, title, description, default,
//         x-freeText, x-termField, x-verbatim, x-invariant-note
//
// 명시적 비지원(429): patternProperties, propertyNames, dependentRequired,
//   dependentSchemas, prefixItems, contains, not, $anchor, $dynamicRef 등
//   draft 2020-12의 나머지 키워드. 이 프로젝트의 7개 schemas/*.json 파일은
//   위 지원 목록만으로 표현되어 있음을 실측 확인했다(node로 키 전수 스캔).
//
// additionalProperties는 스키마 객체(세부 검증)가 아니라 불리언 의미만
// 지원한다 — 이 저장소의 모든 스키마가 `additionalProperties: false`만
// 쓰기 때문이다. true/미지정은 "추가 프로퍼티 허용"으로 취급한다.
//
// oneOf는 "정확히 1개 매칭" 대신 완화된 "최소 1개 매칭"만 검사한다(문서화된
// 한계). state.schema.json의 `artifactEntryOrNull`(`null | artifactEntry`)
// 처럼 분기가 상호 배타적인 실사용 패턴에서는 결과가 동일하지만, 엄밀한
// oneOf 배타성 검사가 필요한 스키마가 추가되면 이 한계를 재검토해야 한다.

const KNOWN_SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "default",
  "type", "properties", "additionalProperties", "required",
  "items", "$ref", "$defs", "allOf", "oneOf", "anyOf",
  "if", "then", "else",
  "enum", "const", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "minItems", "maxItems", "format",
  "x-freeText", "x-termField", "x-verbatim", "x-invariant-note",
]);

const FORMAT_CHECKERS = {
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  "date-time": (v) => !Number.isNaN(Date.parse(v)),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => {
    try {
      // eslint-disable-next-line no-new
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * 스키마 트리(node)를 재귀 순회하며 각 스키마 노드에 대해 visit(node, path)를
 * 호출한다. properties/items/$defs/allOf/oneOf/anyOf/if/then/else를 통해
 * 도달 가능한 하위 스키마 노드까지 전부 방문한다. $ref는 따라가지 않는다
 * (별도 정의 위치에서 이미 방문되므로 중복 방문·순환 위험을 피한다).
 */
export function walkSchemaNodes(node, visit, path = "#") {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  visit(node, path);
  if (node.properties && typeof node.properties === "object") {
    for (const [key, sub] of Object.entries(node.properties)) {
      walkSchemaNodes(sub, visit, `${path}/properties/${key}`);
    }
  }
  if (node.items) walkSchemaNodes(node.items, visit, `${path}/items`);
  if (node.$defs && typeof node.$defs === "object") {
    for (const [key, sub] of Object.entries(node.$defs)) {
      walkSchemaNodes(sub, visit, `${path}/$defs/${key}`);
    }
  }
  for (const kw of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(node[kw])) {
      node[kw].forEach((sub, i) => walkSchemaNodes(sub, visit, `${path}/${kw}/${i}`));
    }
  }
  for (const kw of ["if", "then", "else"]) {
    if (node[kw]) walkSchemaNodes(node[kw], visit, `${path}/${kw}`);
  }
}

/**
 * 스키마 파일 하나를 스캔해, KNOWN_SCHEMA_KEYWORDS에 없는 키를 쓰는 노드를
 * 찾아 {path, keyword}[] 로 반환한다("조용히 통과" 금지 — 호출자가 경고로
 * 보고한다).
 */
export function scanUnsupportedKeywords(schemaDoc) {
  const findings = [];
  walkSchemaNodes(schemaDoc, (node, path) => {
    for (const key of Object.keys(node)) {
      if (!KNOWN_SCHEMA_KEYWORDS.has(key)) {
        findings.push({ path, keyword: key });
      }
    }
  });
  return findings;
}

/** "#/$defs/Name" 형태의 내부 참조만 해석한다. 그 외 $ref 형태는 null. */
export function resolveRef(schema, root) {
  if (schema && typeof schema === "object" && typeof schema.$ref === "string") {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref);
    if (m && root && root.$defs && root.$defs[m[1]]) {
      return root.$defs[m[1]];
    }
    return null; // 지원 범위 밖 $ref 형태
  }
  return schema;
}

function typeMatches(value, type) {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true; // 알 수 없는 type 값은 통과(방어적 — enum 등 다른 절이 잡는다)
  }
}

/**
 * instance가 schema(및 그 하위 제약)를 만족하는지 검사해 오류 문자열
 * 배열을 반환한다(빈 배열이면 적합). root는 $ref 해석에 쓰는 최상위 문서.
 *
 * 이 함수는 "구조적 적합성"만 본다 — AC-19 언어 린트처럼 값의 의미(한국어
 * 포함 여부 등)를 보는 검사는 scripts/lib/lang-lint.mjs가 별도로 담당한다.
 *
 * warnings(5번째 인자, out-array — 호출자가 배열을 전달하면 이 함수가
 * push로 채운다): 순회하는 모든 스키마 노드에서 KNOWN_SCHEMA_KEYWORDS
 * 밖의 키를 만나면 여기 경고를 남긴다. scanUnsupportedKeywords가 스키마
 * 파일 자체를 정적으로 훑는 것과 달리, 이건 validateInstance가 실제로
 * 밟는 노드에 대해서만 경고한다는 차이가 있다 — 두 경로 모두 "지원 밖
 * 키워드를 조용히 통과시키지 않는다"는 동일한 목표를 각자의 시점에서
 * 충족한다. 호출자가 warnings를 넘기지 않으면 기본값(빈 배열)이 매
 * 재귀 호출마다 새로 생기므로 결과를 관측할 수 없다 — 경고를 읽으려면
 * 반드시 배열을 명시적으로 전달하고 호출 후 그 배열을 읽어야 한다.
 */
export function validateInstance(schema, instance, root = schema, path = "$", warnings = []) {
  const errors = [];
  const resolved = resolveRef(schema, root);
  if (resolved === null && schema && schema.$ref) {
    errors.push(`${path}: 지원 범위 밖 $ref 형태(${schema.$ref})`);
    return errors;
  }
  if (!resolved || typeof resolved !== "object") return errors;

  for (const key of Object.keys(resolved)) {
    if (!KNOWN_SCHEMA_KEYWORDS.has(key)) {
      warnings.push(`${path}: 지원 범위 밖 키워드 '${key}' — 이 노드에서는 검증되지 않고 조용히 통과합니다`);
    }
  }

  if (Array.isArray(resolved.oneOf)) {
    const matchCount = resolved.oneOf.filter(
      (sub) => validateInstance(sub, instance, root, path, warnings).length === 0
    ).length;
    if (matchCount === 0) errors.push(`${path}: oneOf 중 어느 것도 만족하지 않음`);
    // 참고: "정확히 1개"가 아니라 "최소 1개"만 강제한다(모듈 상단 주석의
    // 문서화된 한계).
  }

  if (resolved.const !== undefined && JSON.stringify(instance) !== JSON.stringify(resolved.const)) {
    errors.push(`${path}: const 불일치(기대 ${JSON.stringify(resolved.const)})`);
  }

  if (resolved.enum && !resolved.enum.some((v) => JSON.stringify(v) === JSON.stringify(instance))) {
    errors.push(`${path}: enum 불일치`);
  }

  if (resolved.type) {
    const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
    if (!types.some((t) => typeMatches(instance, t))) {
      errors.push(`${path}: type 불일치(기대 ${types.join("|")})`);
      return errors; // 타입부터 틀리면 하위 검사는 의미 없음
    }
  }

  if (typeof instance === "string") {
    if (resolved.pattern && !new RegExp(resolved.pattern).test(instance)) {
      errors.push(`${path}: pattern 불일치(${resolved.pattern})`);
    }
    if (resolved.minLength !== undefined && instance.length < resolved.minLength) {
      errors.push(`${path}: minLength(${resolved.minLength}) 미만`);
    }
    if (resolved.maxLength !== undefined && instance.length > resolved.maxLength) {
      errors.push(`${path}: maxLength(${resolved.maxLength}) 초과`);
    }
    if (resolved.format && FORMAT_CHECKERS[resolved.format] && instance !== "") {
      if (!FORMAT_CHECKERS[resolved.format](instance)) {
        errors.push(`${path}: format(${resolved.format}) 불일치`);
      }
    }
  }

  if (typeof instance === "number") {
    if (resolved.minimum !== undefined && instance < resolved.minimum) {
      errors.push(`${path}: minimum(${resolved.minimum}) 미만`);
    }
    if (resolved.maximum !== undefined && instance > resolved.maximum) {
      errors.push(`${path}: maximum(${resolved.maximum}) 초과`);
    }
  }

  if (Array.isArray(instance)) {
    if (resolved.minItems !== undefined && instance.length < resolved.minItems) {
      errors.push(`${path}: minItems(${resolved.minItems}) 미만`);
    }
    if (resolved.maxItems !== undefined && instance.length > resolved.maxItems) {
      errors.push(`${path}: maxItems(${resolved.maxItems}) 초과`);
    }
    if (resolved.items) {
      instance.forEach((item, i) => {
        errors.push(...validateInstance(resolved.items, item, root, `${path}[${i}]`, warnings));
      });
    }
  }

  if (instance && typeof instance === "object" && !Array.isArray(instance)) {
    const required = resolved.required ?? [];
    for (const key of required) {
      if (!(key in instance)) errors.push(`${path}: required 필드 '${key}' 없음`);
    }
    const props = resolved.properties ?? {};
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in instance) {
        errors.push(...validateInstance(subSchema, instance[key], root, `${path}.${key}`, warnings));
      }
    }
    if (resolved.additionalProperties === false) {
      for (const key of Object.keys(instance)) {
        if (!(key in props)) errors.push(`${path}: additionalProperties 위반('${key}')`);
      }
    }
  }

  if (Array.isArray(resolved.allOf)) {
    for (const sub of resolved.allOf) {
      if (sub.if) {
        const ifErrors = validateInstance(sub.if, instance, root, path, warnings);
        if (ifErrors.length === 0 && sub.then) {
          errors.push(...validateInstance(sub.then, instance, root, path, warnings));
        } else if (ifErrors.length > 0 && sub.else) {
          errors.push(...validateInstance(sub.else, instance, root, path, warnings));
        }
      } else {
        errors.push(...validateInstance(sub, instance, root, path, warnings));
      }
    }
  }

  return errors;
}
