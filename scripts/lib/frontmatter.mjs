// scripts/lib/frontmatter.mjs
//
// SKILL.md 상단의 YAML frontmatter(`---`로 감싼 블록)에서 최소한의 필드만
// 뽑아내는 자작 파서. 의존성 0이므로 범용 YAML 파서를 쓰지 않는다.
//
// 지원 범위(명시): 최상위 `key: value` 스칼라 쌍만 지원한다.
//   - 값이 따옴표(`"..."`, `'...'`)로 감싸여 있으면 벗겨낸다.
//   - 여러 줄 스칼라(`|`, `>`), 중첩 객체/배열, 앵커/별칭 등은 지원하지
//     않는다 — 이 프로젝트의 SKILL.md frontmatter는 name/description
//     처럼 한 줄짜리 문자열 필드만 요구하므로(§ conventions.md 5) 이
//     범위로 충분하다.
// 지원 범위 밖 문법을 만나면 해당 줄은 조용히 무시한다(파서가 크래시하지
// 않는 것이 우선 — validate-plugin은 필수 필드 부재를 별도로 검사한다).

/**
 * @param {string} raw SKILL.md 파일 전체 텍스트
 * @returns {{ fields: Record<string,string>, raw: string } | null}
 *   frontmatter 블록이 없으면 null.
 */
export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const block = m[1];
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue; // 지원 범위 밖 줄(중첩 등) — 경고 없이 스킵
    const key = kv[1];
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, raw: block };
}
