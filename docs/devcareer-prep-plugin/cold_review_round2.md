# 콜드 리뷰 라운드 2 (2026-09-01) — 산문 규칙 대 집행 장치

**대상**: 레포 전체. **초점 하나**: 「규칙이 산문으로만 있는가, 코드가 강제하는가」.

착수 계기는 사용자의 문제 의식이다 — 「md에 적힌 규칙 분량이 많으면 지켜지지 않을 가능성이
높다. 기능들이 규칙 어김 없이 진행되게 하려면 무엇이 코드로 강제돼야 하는가.」

**수행 형태**: 규칙 수집 6렌즈 → 매핑 3각도 → **실제 공격 3** → 판정 1. 공격 단계가 이
리뷰의 값이다 — 규칙을 격리 사본에서 **실제로 어기고** 무엇이 잡는지 실측했다.

> **라운드 1(`cold_review.md`)과 다른 축이다.** 그쪽은 「이 코드에 결함이 있는가」였고,
> 이쪽은 「이 규칙에 장치가 있는가」다. 겹치는 항목은 없다.

---

## 집행 등급 어휘

이 문서 전체가 다섯 등급을 쓴다. **강한 순서**다.

| 등급 | 뜻 |
|---|---|
| `schema` | JSON Schema가 구조로 막는다(required·additionalProperties·enum·if/then·minItems). **표현 자체가 불가능하다.** |
| `runtime` | 프로덕션 CLI가 실행 중에 거부한다(종료 코드·기입 주체 검사·저장 경계). 어기면 그 자리에서 죽는다. |
| `assertion` | 스모크 단언이 관측한다. 어기면 게이트가 빨개진다 — **단, 누가 게이트를 돌릴 때만.** |
| `source-scan` | 소스·문서 스캔 오라클(`SP-*`·`LN-*`·`DH-1`류). 문서가 명령을 적었는지는 보지만 **실제 실행은 보증하지 않는다.** 보조 방어다. |
| `prose` | 집행도 관측도 없다. 사람/LLM이 지키기를 바랄 뿐이다. |

---

## 1. 결론 — 분량을 줄이는 것은 답이 아니다

추적 `.md` 산문은 **645,873바이트(30개 파일)**다. 그중:

| 구간 | 비중 | 성격 |
|---|---|---|
| 회차 기록 3종(`slice_b_spec_review`·`cold_review`·`plan_critic_findings`) | **54.7%** | 어떤 장치도 읽지 않는다. 사람이 읽는 이력이다. |
| `spec.md` | 20.9% | 계약의 원천. LLM이 실행 중에 읽지 않는다. |
| **스킬 실행 산문**(두 `SKILL.md` + 템플릿 5종 + 루트 `CLAUDE.md`) | **10.0%(64KB)** | **LLM이 실행 중에 따라 읽는 유일한 구간.** |

**위험은 10% 구간에 몰려 있고, 그 구간에서 실제로 줄일 수 있는 것은 6KB 안팎(약 9%)이다.**
나머지는 지우면 방어가 함께 사라진다. 그러므로 답은 **「짧게 쓰기」가 아니라 「승격하기」**다.

구별되는 하중 규칙은 **약 140건**(추정, ±15). 공격 실측을 반영한 분포는 대략
`schema` 35 · `runtime` 55 · `assertion` 12 · `source-scan` 12 · `prose` 26이다.
숫자만 보면 집행률 73%로 건강해 보이지만 **이 분포는 질문에 답하지 않는다.**

### 의미 있는 절단면은 런타임 경로다

「사용자가 `/devcareer-prep:career-from-git`을 치고 나서 `career.md`가 눈앞에 놓이기까지」의
경로에서 실제로 **무언가를 거부하는** 장치는 `write-artifact.mjs`가 자기 안에서 도는
**3종이 전부**다(기입 주체 계약 · 재생성 병합 · 쓰기 직전 자기 스키마 검증).

그리고 세 가지 비대칭이 그 3종을 무력화한다:

1. **렌더에는 0종이 있다.**
2. **`write-artifact`를 건너뛰면 3종도 0종이 된다.**
3. **판정 단계(`fact-checked`) 이후는 전면 무집행이다.**

---

## 2. 가장 비싼 미포착 — 사용자가 읽는 마지막 1미터

`scripts/render-markdown.mjs`는 **아무 JSON이나** 받는다. 그 import는 `fs`·`node:url`·
`render-contract.mjs`뿐이다 — `validateInstance`도 `computeArtifactContentHash`도
`checkStorageBoundary`도 없다.

**실측(오케스트레이터가 직접 재현).** 다음이 전부 담긴 파일을 `--in`으로 넣었다:
레포에 없는 40자 해시 인용 · `verification.status: "verified"` 자칭 ·
`contentHash: "deadbeef"` · required `coverage`·`truncated` **통째 부재**.

```
RENDER_EXIT=0
```

나온 문서는 이렇게 읽힌다:

```
### forged-1                                    ← 배지 없음
- 근거 등급: 커밋 근거 · 검증: verified (시도 0회)
- 절단 없음(전량 분석)
```

같은 노드의 `verification`만 `not-attempted`로 바꾼 정직한 산출물은 이렇게 나온다:

```
### honest-1 `근거 부족 - 미검증`               ← 배지 있음
- 근거 등급: 커밋 근거 · 검증: not-attempted (시도 0회)
```

**위조본이 정직한 산출물보다 깨끗해 보인다.** `badgeForNode`가 오직
`node.verification.status`에서만 파생하므로 **자칭 `verified`가 강등 배지를 끈다** —
방어용으로 도입한 필드가 공격자 자산이 됐다.

### 그리고 렌더 계약 안에서 절대 규칙 6이 깨져 있다

`scripts/lib/render-contract.mjs`의 `formatTruncation`:

```js
if (reason === "none" || reason === undefined) return NO_TRUNCATION_NOTICE;
```

**`undefined`(부재)가 「절단 없음(전량 분석)」이라는 적극적 주장으로 강등된다.**
`coverage` 쪽은 「미기재」로 정직하게 떨어지는데 절단 쪽만 안심 문구가 된다. 바로 위 주석이
「침묵은 '절단 없음'과 구별되지 않는다」고 의도를 적어 뒀는데, `undefined`를 `"none"`과
같은 가지에 둔 순간 그 의도가 뒤집혔다.

### 왜 이것이 가장 비싼가

1. **이 제품이 막겠다고 표방한 실패의 원형 그 자체다** — 근거 없는 경력 주장이 「검증 완료」로
   사용자에게 제시된다.
2. **위조본이 더 신뢰돼 보인다** — 방어 필드가 공격자 쪽으로 넘어갔다.
3. **부재가 안심 문구로 강등된다** — 절대 규칙 6이 렌더 경로에서 깨져 있다.
4. **흔적이 남지 않는다** — 어떤 스크립트도 `.md`를 읽지 않는다(`--secret-scan`조차 보지
   않는다고 `tests/contamination/README.md` §9가 자인한다). 다른 미포착들은 최소한 파일에
   흔적이 남아 사후 감사가 가능하지만 이것은 아니다.

진입 비용은 0이다. 절대 규칙을 어긴다는 자각조차 필요 없다 — LLM이 자기가 조립한 임시 JSON을
`--in`으로 주기만 하면 된다.

---

## 3. 오케스트레이터가 직접 재현한 것

에이전트 보고를 그대로 받지 않고 다시 돌린 것만 적는다.

| 위반 | 결과 |
|---|---|
| 날조 `career.json` 렌더(위 §2) | **아무것도 잡지 않음.** exit 0 |
| `--lang-check`를 빈 디렉터리에 | **아무것도 잡지 않음.** `[PASS]` exit 0 |
| `write-artifact.mjs`가 시크릿을 보는가 | `secret`·`redact` 참조 **0건** |
| `lintFreeText` 호출자 | `validate-plugin.mjs` **하나뿐** — 프로덕션 쓰기 경로에 없다 |
| `formatTruncation`의 `undefined` 분기 | 소스로 확인 |
| 정직한 산출물 vs 위조본 배지 | 두 문서를 실제로 렌더해 대조 |

---

## 4. 처방 — 우선순위 순

`슬라이스 A` 열이 `아니오`면 예외 표를 건드리지 않고 오늘 할 수 있다는 뜻이다.

| # | 처방 | 등급 | 슬라이스 A | 비용 |
|---|---|---|---|---|
| 1 | **`render-markdown.mjs`에 입력 게이트** — 이미 export된 `validateInstance`·`computeArtifactContentHash`를 import해 렌더 직전 자기 검증, 부적합이면 exit 1 | prose→**runtime** | 아니오 | M |
| 2 | **`write-artifact.mjs`에 `scanForSecrets`·`lintFreeText` 배선** — import 두 줄로 AC-11·AC-19가 처음으로 실산출물에 걸린다 | prose→**runtime** | 아니오 | M |
| 3 | **`fact-checked` 단계 불변식 넷** — 「판정을 자칭하지 마라」가 지금 전면 무집행이다(노드 삭제·서술 개작·판정 자칭이 전부 통과) | prose→**runtime** | 아니오 | M |
| 4 | **`verify-evidence.mjs`의 `layerRefUnverifiable` fail-open을 닫는다** — 예외 5번이 같은 함수의 같은 형태를 이미 닫았다 | prose→runtime | **예** | S |
| 5 | **`write-config.mjs`가 원장을 대조한다** — 저자 게이트 미완료가 지금 exit 0으로 기록된다 | prose→runtime | 아니오 | M |
| 6 | **`PreToolUse` 훅으로 도구 호출 층을 막는다** — 절대 규칙 1·2를 프로세스 밖에서 관측하는 유일한 수단 | source-scan→runtime | 미확정 | L |
| 7 | **`write-artifact.mjs`가 쓰기 시점에 `parentRefs`를 해소한다** — 계층 구조가 지금 쓰기 시점에 아무 하중도 받지 않는다 | prose→runtime | 아니오 | M |
| 8 | **검증 영수증** — `verify-evidence` 실행 사실을 기록하고 렌더가 대조. 「검증했다」와 「검증했다고 말했다」를 구별하는 수단이 지금 0이다 | prose→**runtime** | 아니오 | L |
| 9 | **`--skill` 값을 실재 스킬 집합과 대조** — `generatedBySkill`이 `minLength: 1` 자유 문자열이라 지어낸 이름이 exit 0으로 박힌다 | schema→runtime | 아니오 | **S** |
| 10 | **`runLangCheck`의 fail-open을 닫는다** — 같은 파일 안에서 `runSecretScan`·`runSchemaCheck`는 fail-closed인데 이쪽만 대상 0건에서 초록이다 | runtime→runtime | **예** | S |
| 11 | **총량 가드 연산자 관측 + 슬라이스 A 내용 핀** — 절대 규칙 4·5를 어기는 편집을 지금 아무도 보지 않는다 | prose→assertion | 아니오 | L |
| 12 | **`--contamination`을 `npm test`에 잇거나 「네 게이트」가 무엇을 뺀 수인지 못 박는다** | assertion→assertion | **예** | S |

### 처방 2(추가) — `formatTruncation`의 부재 분기

위 표에 없는 규모 S 항목 하나를 여기 적는다. `formatTruncation`이 `undefined`를 `"none"`과
같은 가지에 두는 것을 분리해 **부재는 「미기재」**로 떨어뜨린다. `render-contract.mjs`는
슬라이스 B 파일이라 예외가 필요 없고, 양방향 단언 2건이면 관측된다.

---

## 4-1. 반영 기록 — 처방 2·9 (2026-09-01)

**단언 `(RT-1)`·`(RT-2)`·`(AP-1)`~`(AP-3)` 신설, 정본 상수 536 → 541.**
게이트: lint exit 0 / 기본 **543** / `--negative` **35** / `--golden` **13** /
`--contamination` **10**, 전부 0 FAIL.

### 처방 2 — `formatTruncation`의 부재 분기

세 갈래로 나눴다: `undefined` → `UNKNOWN_TRUNCATION_NOTICE`(「미기재」) ·
`"none"` → `NO_TRUNCATION_NOTICE`(「절단 없음」) · 그 밖 → 사유와 건수.
새 상수는 `TRUNCATION_NOTICE_PREFIX`로 시작하므로 `RENDER_REQUIRED_ELEMENTS`의
`truncation` 프로브가 그대로 통과한다 — **부재를 정직하게 적어도 「절단 고지 요소가 있다」는
계약은 성립한다.**

정상 경로에서는 스키마가 `truncated`를 required로 강제하므로 이 갈래에 **도달할 수 없다.**
도달했다면 그것은 스키마를 거치지 않은 입력이라는 뜻이고, 그 사실이 사용자가 읽는 문서에
남아야 한다.

### 처방 9 — 산출물 생산자 인증

`artifact-contract.mjs`(슬라이스 B)에 `KNOWN_SKILLS`·`NON_SKILL_PRODUCERS`·
`KNOWN_ARTIFACT_PRODUCERS`를 두고 `write-artifact.mjs`가 `--skill`을 대조해 미지 값이면
exit 2로 거부한다. **`state.schema.json`을 좁히지 않은 이유는 그 파일이 슬라이스 A라서**이며,
그 사실을 상수 주석에 적었다.

`NON_SKILL_PRODUCERS`에 `contamination-fixture`를 **근거와 함께** 넣었다 — 회차 재료화는
사람이 스킬을 돌린 것이 아니라 스크립트가 만든 것이고, `career-from-git`으로 적으면
레지스트리가 거짓을 말한다. **실제 이름을 쓰는 것이 정직하다.**

`(AP-1)`이 상수와 `skills/` 디렉터리를 **양방향**으로 대조한다 — 한 방향만 보면 스킬을 새로
만들고 상수를 안 고쳐도(또는 그 반대여도) 조용히 지나간다.

### 변이 6종 관측 — 격리 사본

| 변이 | FAIL |
|---|---|
| P1 부재를 다시 「절단 없음」으로 강등(결함 복원) | **(RT-1)만** 542/1 |
| P2 세 갈래를 전부 「미기재」로 뭉갬 | **(RT-2)만** 542/1 |
| P3 상수에 실재하지 않는 스킬을 더함 | **(AP-1)만** 542/1 |
| P4 생산자 대조를 제거(배선 해제) | **(AP-2)만** 542/1 |
| P6 회차가 실제로 쓰는 생산자 하나만 집합에서 뺌 | **(AP-3)만** 542/1 |
| P5 허용 집합을 통째로 비움 | (AP-3) + `WA-*` 27건 + 가드 = **33 FAIL** |

**P5는 「자기 몫만 FAIL」의 예외이고, 그 예외를 감추지 않는다.** 허용 집합을 비우면
`write-artifact`가 **모든** 쓰기를 거부하므로 제품 기능이 통째로 꺼진다 — 그것을 여러 단언이
함께 잡는 것은 옳다. 다만 그 결과로는 `(AP-3)`이 고유 관측점을 갖는지 알 수 없어 **P6을
따로 만들었다.** `WA-*` 계열은 `--skill career-from-git` 하나만 쓰므로
`contamination-fixture` 누락을 잡지 못하고, 그래서 P6에서 `(AP-3)`만 FAIL한다.

### 남은 것

`render-markdown.mjs`의 입력 게이트(처방 1)는 **아직 없다.** 처방 2는 렌더가 **부재를
정직하게 적게** 만들었을 뿐, **아무 JSON이나 받는 것 자체는 그대로다** — 위조된 인용도,
자칭 `verified`도, 위조 `contentHash`도 여전히 exit 0으로 렌더된다. §2의 미포착은
처방 1을 반영하기 전까지 열려 있다.

---

## 5. 지울 수 있는 산문 — 승격이 이미 끝난 것

**먼저 크기를 정직하게 말해 둔다.** 스킬 실행 경로 산문 64KB 중 실제로 줄일 수 있는 것은
**6KB 안팎(약 9%)**이다. 아래는 장치가 이미 강제해 문서가 두 번째 사본으로만 남은 것들이다.

- **`career-from-git/SKILL.md` 1-b단계의 「`schemaVersion`·`updatedAt`은 담지 마라」**
  — 완전히 무료다. `assembleConfig`가 `return { ...base, schemaVersion: …, updatedAt: … }`로
  스탬프를 스프레드 **뒤**에 둔다. 담든 안 담든 결과가 바이트 동일하므로 **애초에 어길 수
  있는 규칙이 아니다.**
- **같은 절의 「나머지 일곱은 default가 있어도 반드시 담아라」** — 무료이고 지우는 편이 더
  정확하다. `write-config.mjs`의 실패 메시지 리터럴에 거의 같은 문장이 이미 있고,
  **어느 필드가 빠졌는지는 스크립트가 경로로 알려 준다.**
- **두 `SKILL.md` 2단계의 「`--root`/`--out`은 `.devcareer` 안이어야」** — 무료다.
  `project-ledger.mjs`가 두 인자 모두에 `checkStorageBoundary`를 걸고 exit 2로 거부한다.
  (**단, 처방 1 전까지 렌더의 `--out`에 대해서만은 이 문장이 여전히 하중을 진다.**)
- **`knowledge-mapper.md`·`gap-analyzer.md`의 「`basis`에 `commit`을 쓸 수 없다」·
  「`parentRefs`를 비우지 마라」** — 무료다. `$defs.basis.enum`이 `commit`을 아예 담지 않고
  `parentRefs.minItems: 1`이 빈 배열을 거부한다. **표현 자체가 불가능하다.**
- **`career-from-git/SKILL.md` 3단계의 「출력에 `verification`·`locked`가 없어야」** —
  조건부 삭제이며 **사본 셋 중 `SKILL.md` 쪽만 지워라.** `checkAuthorshipContract`가 값과
  무관하게 **필드 존재만으로** exit 1을 낸다. 남길 것은 **템플릿 사본**이다 —
  `(SP-6a)`가 관측하는 것도 그쪽이고, 실제로 그 필드를 쓸지 결정하는 것도 템플릿을 읽는
  서브에이전트다.
- **`conventions.md` §5의 SKILL frontmatter 규약** — 무료다. `checkSkills`가 5종 코드로
  exit 1을 내고 `fixtures-invalid`의 02·03·24·25·26·27이 각 갈래를 회귀로 잡는다.
- **두 `SKILL.md`의 「사용자에게 보고할 때」 4문단** — 지우는 대신 **리다이렉트하라**:
  「렌더 마크다운의 헤더 블록과 강등 배지가 붙은 노드 수를 그대로 인용해 보고한다. 요약해
  다시 쓰지 마라」 한 지시로 바꾸고 그 문구의 실재를 소스 스캔으로 관측한다. **산문 4문단이
  지시 1문장으로 줄고 동시에 집행이 붙는 유일한 항목이다.**

---

## 6. 한계 — 감추지 않는다

- **판정자가 게이트를 직접 돌리지 않았다.** 현재 트리 0 FAIL은 공격자 실측에 의존한다.
- **공격 실측 약 40건 중 판정자가 독립 재검증한 것은 10건, 오케스트레이터가 재현한 것은
  6건이다.** 나머지는 공격자 로그를 그대로 받았다.
- **제안한 장치를 격리 사본에 변이로 넣어 확인하지 않았다** — 절대 규칙 3이 요구하는
  절차이며, 각 처방을 반영할 때 별도로 밟아야 한다. 이 리뷰는 **「무엇이 지금 열려 있는가」만
  실측했고 「제안한 마개가 맞는가」는 실측하지 않았다.**
- **공격자 서술 하나를 판정자가 정정했다** — 「`git.mjs`에 닿는 단언이 방향 역전」이라는
  보고는 `(LN-3)`의 **의도된 설계**를 오독한 것이었다(그 주석이 「이 단언이 PASS라는 것은
  결함이 살아 있다는 뜻」이라고 스스로 적어 뒀다). 같은 종류의 방향성 오독이 다른 서술에
  더 있을 수 있으나 전수 대조하지 않았다.
- **하중 규칙 「약 140건」은 기계적 집계가 아니라 추정이다**(±15). 반면 산문 바이트 수는
  `git ls-files '*.md'`로 직접 잰 값이다.
- **`tests/run-smoke.mjs` 9,436행을 통독하지 않았다.** 「장치 없음」으로 판정한 규칙 중
  일부를 이미 관측하는 단언이 읽지 않은 구간에 있을 가능성을 배제하지 못한다.
- **처방 6(`PreToolUse` 훅)의 전제를 확인하지 못했다** — `hooks/hooks.json`이
  `plugin.json` 수정 없이 자동 발견되는지 확인할 수 없었다. 자동 발견되지 않으면 그 처방의
  슬라이스 A 예외 여부가 뒤집힌다.
- **슬라이스 경계 판정에 불확실성이 남는다.** `tests/run-smoke.mjs`는 예외 표에 없는데도
  슬라이스 B가 계속 단언을 추가해 왔다. 실무 관례를 따라 「예외 불필요」로 적었으나
  **이 판단은 사용자가 확정해야 한다.**
