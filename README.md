# devcareer-prep

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

Git 커밋 히스토리를 **결정적 스크립트**로 수집해 만든 "증거 원장(evidence ledger)"을 유일한
사실 원천으로 삼고, 그 위에 경력 기술서 → 기술 지식맵 → 학습 갭 리포트를 단방향 계층으로 쌓는
Claude Code 플러그인이다. 모든 인용의 실재성은 LLM이 아니라 스크립트가 검증한다.

> **현재 상태: 구현 진행 중 (Phase 1 — 결정적 하네스 완료, 경력 계층 스킬 착수).**
> **된 것**: L0 수집기(`scripts/collect-git-facts.mjs`)·인용 검증기
> (`scripts/verify-evidence.mjs`)·Layer 1 기계 검증(`scripts/validate-plugin.mjs`)과
> 7개 JSON Schema(`schemas/`)에 더해, 산출물 쓰기 경계(`scripts/write-artifact.mjs`)·
> 설정 쓰기 경계(`scripts/write-config.mjs`)·원장 투영(`scripts/project-ledger.mjs`)·
> 마크다운 렌더(`scripts/render-markdown.mjs`)와
> 경력 계층 스킬(`skills/career-from-git/`)이 구현·배선돼 있다. `npm run lint`와
> `npm test`가 로컬에서 그대로 통과한다(아래 "빠른 시작"의 명령을 그대로 복사해 실행하면
> 재현된다).
> **안 된 것**: 학습 계획 계층의 스킬(*skills/prep-plan/*)은 아직 없고, 오염 주입 테스트
> 스위트와 실제 레포 도그푸딩도 남아 있다(아래 표에서 이탤릭으로 표시한 경로는 아직
> 존재하지 않는 계획된 경로다).
> 아래 "지금 무엇이 되고 무엇이 안 되는가"에 파일 단위로 정리했다.

## 설치

**마켓플레이스로 설치 (배포 이후):**

```
/plugin marketplace add Jugger0716/career-forge
/plugin install devcareer-prep@career-forge
```

**로컬 개발 테스트:**

```
claude --plugin-dir /path/to/career-forge
```

## 아키텍처 개요 — 증거 원장 → 단방향 6계층

정본은 JSON이고, 사용자 대면 마크다운은 그 JSON을 렌더링한 뷰일 뿐이다. 상위 계층은 하위 계층의
**ID만 참조**하며 역참조는 금지된다 — 이 제약이 "생성된 결과가 실제 경력과 논리적으로 연결된다"는
요구를 스키마 제약으로 강제한다.

| 계층 | 산출물 | 설명 |
|---|---|---|
| L0 | `evidence.json` | git 히스토리에서 결정적으로 수집한 불변 증거 원장. LLM은 이 값을 생성하지 않고 항목 ID만 인용한다. |
| L1 | `career.json` | 경력 기술서. 모든 사실 주장이 근거 등급(`commit`/`inference`/`external`/`insufficient`)을 갖는다. |
| L2 | `knowledge-map.json` | 기술 지식맵. |
| L3 | `gap-report.json` | 학습 갭 리포트. |
| L4 | `plan.json` | 준비 커리큘럼 (Phase 3, P0 이후). |
| L5 | 채점 | 범위 밖 (P2). |

모든 인용은 2단 팩트체크를 거친다: **1단(스크립트, 결정적)**은 원장 실존성·커밋 해시 실존성·
(해시, 경로) 쌍의 diff 등장 여부를 검사하고, **2단(LLM)**은 "이 커밋이 정말 그 주장을 뒷받침하는가"만
적대적으로 판정한다. 해시는 LLM이 생성하지 않으므로 할루시네이션 경로가 구조적으로 막힌다.

산출물의 상태 디렉터리는 `.devcareer/` 다. 기본 저장 위치는 사용자 홈 아래
(`~/.devcareer/<repo-key>/`)이며, 분석 대상 레포 내부에 저장하려면 명시적 동의가 필요하고
이 경우 해당 레포의 `.gitignore`에 `.devcareer/` 추가를 제안한다.

## 지금 무엇이 되고 무엇이 안 되는가

| 영역 | 상태 | 비고 |
|---|---|---|
| `schemas/*.json` (evidence·career·knowledge-map·gap-report·plan·state·config, 7개) | **구현됨** | 자작 검증기(`scripts/lib/schema-validate.mjs`)가 required/type/additionalProperties/enum/if-then 등을 강제한다. |
| `scripts/collect-git-facts.mjs` (L0 결정적 수집기) | **구현됨** | git 히스토리에서 `evidence.json`·`git-facts.json`을 만든다. LLM 호출 0회. |
| `scripts/verify-evidence.mjs` (인용 무결성 검증기) | **구현됨** | L1+ 산출물의 모든 인용을 원장·git과 대조해 검증한다. LLM 호출 0회. |
| `scripts/validate-plugin.mjs` (Layer 1 기계 검증 하네스) | **구현됨** | `npm run lint`가 호출한다 — plugin.json 필드, 스키마 파싱, 문서 내 상대경로 실재성, 명명·라이선스 일관성, 워킹 트리 CR 가드. |
| `tests/run-smoke.mjs` (스모크·negative·골든 테스트) | **구현됨** | `npm test`가 기본 → `--negative` → `--golden` 순서로 호출한다. |
| `scripts/render-markdown.mjs` (JSON → 사용자 대면 `.md` 렌더러) | **구현됨** | 배지·커버리지 수치·절단 고지를 `scripts/lib/render-contract.mjs`의 계약대로 렌더한다. 배지는 `verification`에서만 파생한다. |
| `scripts/write-artifact.mjs` (산출물이 디스크에 닿는 유일한 경로) | **구현됨** | 기입 주체 검사 → 재생성 병합 → 쓰기 직전 자기 스키마 검증 → 원자적 쓰기 → 레지스트리 갱신. 5분기 종료 코드. |
| `scripts/project-ledger.mjs` (원장 → LLM 컨텍스트 투영) | **구현됨** | 범위 밖 커밋을 뺀 투영만 프롬프트에 들어간다. |
| `scripts/write-config.mjs` (`config.json`이 디스크에 닿는 유일한 경로) | **구현됨** | 범위 확정 대화의 결과를 쓰기 직전 `config.schema.json`으로 자기 검증한 뒤 원자적으로 쓴다. `schemaVersion`·`updatedAt`만 스스로 채우고, 나머지는 스키마에 default가 있어도 채우지 않는다 — 무엇을 수집하고 무엇이 산출물에 남는지는 사용자 결정이다. 종료 코드 0/2. |
| `skills/career-from-git/` (슬래시 명령) | **구현됨** | 범위 확정 대화 → 수집 → 투영 → 생성 → 2단 팩트체크 → 인용 검증 → 렌더까지의 오케스트레이션 절차와 템플릿 2종. |
| `skills/skill-gap/` (슬래시 명령) | **구현됨** | 지식맵·갭 리포트 계층. 레지스트리로 상위 산출물을 찾아 근거의 신선도를 먼저 판정하고(0단계), 생성 → 자가진단 수집 → 2단 팩트체크 → 인용 검증 → 렌더까지의 오케스트레이션 절차와 템플릿 3종. |
| *skills/prep-plan/* (슬래시 명령) | **미구현** | 학습 계획 계층. 디렉터리 자체가 이 레포에 없다. |
| `references/sources.json` | **구현됨** | `basis: external` 노드의 URL allow-list. `scripts/verify-evidence.mjs`가 대조한다. |
| *examples/* | **미구현** | 공개 준비 단계에서 만들어질 예정. |

요약하면: **"git 히스토리를 결정적으로 수집하고, 그 수집 결과를 인용하는 산출물의
진위를 스크립트로 검증한다"는 이 프로젝트의 핵심 계약은 이미 코드로 존재하고 테스트로
고정돼 있다.** 아직 없는 것은 그 계약 위에서 실제로 산문(경력 기술서 등)을 생성하는
대화형 스킬이다 — 지금은 아래 "빠른 시작"처럼 세 스크립트를 CLI로 직접 호출해야 한다.

## 빠른 시작 — CLI를 직접 호출하기

아래 3단계는 이 저장소 자체(`career-forge`)를 대상으로 그대로 실행해서 검증한 명령이다
(플레이스홀더 없음 — `<repo>`만 분석 대상 레포의 로컬 경로로 바꾸면 된다).

**1) L0 수집 — `evidence.json` 만들기**

```bash
node scripts/collect-git-facts.mjs \
  --repo <repo> \
  --identity "$(git -C <repo> log -1 --format=%ae)" \
  --max-commits 50 \
  --out ./out
```

전체 CLI 플래그(`node scripts/collect-git-facts.mjs`를 인자 없이 실행하면 그대로 출력된다):

```
node scripts/collect-git-facts.mjs --repo <path> [--ref HEAD|all]
  [--identity <email>]... [--all-identities] [--merge-included]
  [--since <date>] [--until <date>] [--max-commits <n>]
  [--no-bots-exclude] [--no-vendored-exclude] [--out <dir>]
  [--storage home|repo] [--repo-opt-in]
```

- `--identity`는 반복 지정 가능하고 최소 1개 필요하다(또는 탐색·테스트 전용
  `--all-identities` — §5 "저자 정체성은 추측하지 않는다" 게이트를 대신하지 않으므로
  프로덕션 경로에서는 쓰지 않는다). 실제 값은 `git -C <repo> shortlog -sne`로 먼저
  확인한다.
- `--since`/`--until`은 `YYYY-MM-DD` 형식만 받는다(git 상대 날짜 표기는 지원하지 않는다
  — 조용한 파싱 실패를 막기 위한 설계).
- `--max-commits`(기본 1000)를 넘으면 결정적 샘플링으로 절단하고 `truncated`/`coverage`에
  그 사실을 명시한다(아래 "한계 고지" 참조).
- `--out`을 생략하면 `scripts/lib/store.mjs`가 `~/.devcareer/<repo-key>/`(또는
  `--storage repo --repo-opt-in` 지정 시 `<repo>/.devcareer/`)를 저장 루트로 해석한다.

**2) L1+ 산출물의 인용을 검증하기**

아직 스킬 계층이 없으므로 `career.json` 등은 직접(또는 다른 도구로) 만들어야 한다.
`nodes[].evidence[]`에 1단계 원장의 `commits[].id`(예: `commit:<40자 hex>`)만 인용하고
해시를 직접 쓰지 않으면 아래 명령으로 검증된다:

```bash
node scripts/verify-evidence.mjs \
  --repo <repo> \
  --evidence ./out/evidence.json \
  --identity "$(git -C <repo> log -1 --format=%ae)" \
  --artifact career=./out/career.json
```

```
node scripts/verify-evidence.mjs --repo <path> --evidence <evidence.json>
  [--config <config.json>] [--identity <email>]...
  (--artifact <layer>=<path>)... | --out-dir <dir> [--out <path>]
```

`--artifact <layer>=<path>`(layer는 `career`|`knowledge-map`|`gap-report`|`plan`)를 반복
지정하거나, `<dir>`에서 4종 파일명을 자동 탐색하는 `--out-dir <dir>`을 쓴다. 종료 코드는
`0`=PASS, `1`=FAIL(근거 없는 인용 발견), `2`=INCONCLUSIVE(도구·레포 오류로 일부를
검증하지 못함 — "성공"이 아니므로 0을 반환하지 않는다).

**3) 산출물 하나를 스키마로 직접 검증하기(선택)**

```bash
node scripts/validate-plugin.mjs --schema-check ./out/career.json
```

파일명(확장자 제외)으로 `schemas/<layer>.schema.json`을 정해 required/type/
additionalProperties 등을 강제한다. 레포 전체를 검사하려면 인자 없이
`node scripts/validate-plugin.mjs`(=`npm run lint`)를 실행한다.

## 명령 (슬래시 명령)

정본 슬래시 명령 접두사는 `.claude-plugin/plugin.json`의 `name`(`devcareer-prep`)에서
자동 파생되므로 항상 `/devcareer-prep:`이다. 아래 네 명령 중 **구현된 것은 P0 두 개**이고
나머지 둘은 아직 없다.

| 명령 | 범위 | 상태 |
|---|---|---|
| `/devcareer-prep:career-from-git` | P0 (MVP) | **구현됨** |
| `/devcareer-prep:skill-gap` | P0 (MVP, 자가진단 입력만) | **구현됨** |
| `/devcareer-prep:prep-plan` | Phase 3 | 계획됨 — 미구현 |
| `/devcareer-prep:grade` | P2 (MVP 제외) | 범위 밖 |

## 개발

```bash
npm run lint   # scripts/validate-plugin.mjs — Layer 1 기계 검증(레포 루트 전체)
npm test       # tests/run-smoke.mjs 기본 → --negative → --golden 순서로 3회 실행
```

의존성은 0이다(`package.json`의 `dependencies`/`devDependencies`가 비어 있다) — Node
내장 모듈(`node:fs`/`node:child_process`/`node:crypto` 등)만 쓴다.

## 한계 고지 — 이 플러그인이 보증하지 않는 것

- **로컬 경로만 지원한다.** 원격 GitHub URL을 직접 clone하지 않는다 (P0 범위 밖 — 수동으로
  clone한 뒤 로컬 경로를 지정해야 한다).
- **`max_commits` 예산을 넘으면 전체 커밋을 다 분석하지 않는다.** 이 경우 결정적 샘플링 규칙에
  따라 부분 선택하며, 절단 여부와 커버리지 수치를 산출물 헤더에 항상 명시한다 — 하지만 "명시한다"는
  것이지 "모든 커밋을 본다"는 뜻은 아니다.
- **'근거 없는 주장' 탐지는 100%가 아니다.** 가짜 커밋 해시·타 저자 커밋 인용·마스킹 우회 같은
  기계적으로 결정 가능한 오염은 100% 탐지를 목표로 하지만, LLM이 판정하는 "이 서술이 정말
  근거 없는 과장인가"는 반복 실행 기준 80% 이상 탐지율만 보증한다.
- **시크릿/PII 마스킹은 커밋 제목(`subject`)·co-author 트레일러(`coAuthors`)에 적용되며,
  알려진 패턴 기반이라 완전하지 않다.** 원장(`evidence.json`)을 쓰는 시점에 AWS 키·
  private key 블록·JWT·`password=`류 필드·이메일 패턴을 `[REDACTED:<name>]`로 치환하지만,
  이 목록에 없는 형태의 민감정보까지 잡아내지는 못한다. 커밋 해시(`hash`/`shortHash`,
  제목 안에 인용된 40자 hex 문자열 포함)는 마스킹 대상에서 제외된다 — 이 값이 이 도구
  전체의 인용 앵커이기 때문이다. **코드 원문(diff) 인용 경로는 P0에 아직 존재하지 않으므로
  이 마스킹의 적용 범위 밖이다** — `config.json`의 `snippetQuoting`은 그 경로를 위한
  자리표시자 플래그이며, 구현되면 같은 마스킹 모듈(`scripts/lib/redact.mjs`)을 재사용할
  계획이다.
- **선택되지 않은 저자·봇의 커밋도 원장(`evidence.json`)에 전량 등재된다 — 절단 실행을 관측
  가능하게 하기 위해서다.** 다만 그 레코드에서 **저자 이메일·커밋 제목·co-author 트레일러는
  기록되지 않는다**(각각 `null`·`null`·빈 배열). 마스킹이 아니라 미기록이며, 스키마가 조건부
  제약으로 강제해 위반 원장은 `--schema-check`에서 FAIL 한다. **그럼에도 제외 커밋의 변경 경로
  (`files[].path`)와 작성 시각(`authorDate`)은 원장에 남는다** — 집합 동치 검증과 순회 재현에
  필요하기 때문이며, 이 두 값은 동료의 담당 영역과 활동 시각을 드러낸다. **원장 파일 자체를 외부로
  공유하지 마라.** 또한 탐색·테스트 전용인 `--all-identities`는 '저자 미선택' 축만 무력화하므로 **타 저자의
  비-봇·기간 내 커밋이 '제외되지 않음'이 되어 이메일·제목이 평문으로 기록된다**(봇·기간 밖·머지
  제외분은 여전히 축소된다) — 프로덕션 경로에서 쓰지 않는다.
- **코드 원문 인용은 기본 비활성이다.** 옵트인하지 않으면 경로·해시·요약만 인용하며 diff 원문은
  전송되지 않는다.
- **채점(`/devcareer-prep:grade`), 시스템 설계 문제 생성, 면접 꼬리질문, 여러 레포 통합 분석,
  음성 모의면접, 이력서 PDF 생성, Claude 외 LLM 지원은 MVP 범위 밖이다.**
- **저자 정체성은 추측하지 않는다.** 첫 실행 시 `git shortlog -sne` 결과에서 사용자가 직접
  자기 identity를 선택해야 하며, 이 플러그인이 임의로 "이 커밋은 당신 것"이라고 판단하지 않는다.
- **P0 슬래시 명령 둘은 아직 실레포에서 검증되지 않았다.** `/devcareer-prep:career-from-git`과
  `/devcareer-prep:skill-gap`은 절차서·템플릿이 실재하고 그 배선을 스모크가 관측하지만,
  **실제 레포 도그푸딩(AC-20)은 아직 수행되지 않았다** — 두 계층 산출물의 *내용* 정확성은
  픽스처 밖에서 관측된 적이 없다. `/devcareer-prep:prep-plan`은 미구현이다. "빠른 시작"의
  CLI 3종은 스킬 없이 직접 호출하는 경로로 계속 유효하다.

## 라이선스

[MIT](./LICENSE)
