# Project Conventions — career-forge (DevCareer Prep)

> **출처 고지**: 이 레포는 이번 세션에서 `git init`된 **빈 레포**다 (`.gitignore` 1개 커밋만 존재).
> 따라서 코드베이스 스캔으로 도출된 관례는 **하나도 없다**. 아래 내용은 전부
> (a) 사용자 전역 `~/.claude/CLAUDE.md`, (b) 사용자 제공 SPEC 원문
> (`docs/devcareer-prep-plugin/SPEC_INPUT.md`) 에서 온 **선언된 제약**이며,
> 관찰된 기존 패턴이 아니다. Planner는 이를 "지켜야 할 규칙"으로 취급하되
> "이미 존재하는 코드 패턴"으로 오인하면 안 된다.

## 1. 언어 규약 (전역 CLAUDE.md — 구속력 있음)

- 사용자 대면 출력(설명·보고·질문·요약)은 **한국어**가 기본값이다.
- 코드 주석 / 커밋 메시지 / 식별자 / 로그·상태 키워드(PASS/FAIL 등)는 프로젝트 관례를 따른다.
  → 이 프로젝트는 신규이므로 **식별자·파일명·커밋 메시지는 영어**, **사용자 대면 산출물은 한국어**로 확정한다.
- 서브에이전트/워크플로 스크립트를 띄울 때 프롬프트 첫 줄에 출력 언어를 명시하고,
  스키마 free-text 필드 설명에 "(한국어로)"를 포함한다. 영어 누수는 스타일 문제가 아니라 **버그**다.
  → 이 플러그인이 **스스로 띄우는** 서브에이전트에도 동일 규칙이 적용된다 (자기 적용).

## 2. 서브에이전트 모델 라우팅 (전역 CLAUDE.md — 구속력 있음)

- 기계적 수집/탐색/집계 에이전트 → sonnet 이하.
- 판정 / 적대검증 / 최종리뷰 에이전트만 상위 모델.
- 세션 모델을 대량 병렬 에이전트에 그대로 상속시키지 않는다.
  → 이 플러그인의 `GitExtractor`는 기계적 수집이므로 저비용 티어,
    `FactChecker`는 판정이므로 상위 티어로 설계해야 한다. **SPEC에 없는 제약이지만 강제된다.**

## 3. 세션 연속성 (전역 CLAUDE.md)

- 경계(하루 끝, 에픽 단계)에서 끊을 때 `/handoff`로 HANDOFF 문서 생성, 새 세션은 `/handoff resume`.

## 4. 플랫폼 제약 (관찰된 환경 사실)

- OS: Windows 11, 기본 셸 PowerShell 7+. Bash(Git Bash)도 사용 가능.
  → 플러그인이 생성하는 명령/스크립트는 **POSIX 전용 문법을 가정하면 안 된다**.
    `git` 자체는 크로스플랫폼이므로 내장 git 명령 호출이 안전한 기본값.
- 저장소 경로 구분자: 산출물에는 `/` 사용 (git 출력과 일치).

## 5. Claude Code 플러그인 구조 규약 (SPEC + 플랫폼 요구사항)

- 플러그인 매니페스트는 `.claude-plugin/plugin.json`.
- Skill은 `skills/<name>/SKILL.md` 형태이며, YAML frontmatter에 `name`, `description` 필수.
  `description`은 "언제 쓰는지"를 3인칭으로 서술한다 (Claude가 라우팅에 사용).
- Agent 정의는 `agents/<name>.md`, frontmatter에 `name`/`description`/`tools`/`model`.
- 산출물 저장 디렉터리: `.devcareer/` (SPEC 지정).

## 6. 할루시네이션 방지 규약 (SPEC — 강제, 최우선)

- 모든 사실적 주장은 **git 커밋 해시** 또는 신뢰 가능한 출처를 인용해야 한다.
- FactChecker가 승인하지 않으면 출력하지 않는다.
- 불확실하면 `근거 부족`이라고 **명시**한다. 추측을 사실처럼 쓰지 않는다.
  → 이 규약은 이 프로젝트의 핵심 가치이므로, 어떤 설계 선택도 이것을 약화시키면 안 된다.

## 7. 빌드/테스트/린트 (현재 상태)

- 감지된 build/test/lint/type-check 명령이 **없다** (마크다운·JSON 위주 플러그인).
- → Layer 1 기계 검증이 사실상 비활성이다. 완료 판정은 Layer 2/3(LLM 판단)에 의존한다.
- 만약 계획 단계에서 JSON 스키마 검증이나 스킬 frontmatter 린트를 추가한다면,
  그것이 이 프로젝트 최초의 기계 검증 수단이 된다 (권장).

## 8. 라이선스 · 배포 대상 (사용자 확정 — SPEC의 미확정 항목 해소)

- **라이선스: MIT로 확정**. `LICENSE` 파일이 이미 레포 루트에 존재한다 (GitHub 생성분, 커밋 `31e603d`).
  → SPEC의 "MIT 또는 Apache-2.0" 미확정 상태는 **해소됨**. README / `plugin.json` / 문서의 라이선스 표기는
    전부 MIT로 일치시켜야 하며, Apache-2.0을 전제한 설계는 하지 않는다.
- **원격 레포: `https://github.com/Jugger0716/career-forge.git` (public)**.
  → 레포 이름이 `career-forge`로 고정되었다. SPEC의 제안 구조는 `devcareer-prep/`을 루트로 그렸으므로
    **플러그인 루트를 레포 루트로 볼 것인지, `devcareer-prep/` 하위로 둘 것인지가 미결 쟁점**이다.
    이는 `.claude-plugin/plugin.json`의 위치를 좌우하므로 스펙 확정 게이트에서 반드시 결정해야 한다.
- **public 레포**이므로 처음부터 공개를 전제한다: 개인 식별 정보, 로컬 절대경로, 실제 커밋 해시가 담긴
  개인 경력 데이터(`.devcareer/`)는 커밋 대상이 아니며 `.gitignore`에 포함되어야 한다.

## 9. 문서 위치 규약 (2026-08-20 확정 — harness 산출물 vs 프로젝트 기억)

- **`docs/harness/`는 gitignore된다.** `/harness`·`/deep-review`·`/handoff`가 쓰는 **도구 작업
  디렉터리**이며, 회차 산출물이 기본으로 커밋되는 것은 잘못된 기본값이다.
- **남길 가치가 있는 문서는 `docs/` 아래로 명시적으로 승격한다.** 현재 위치:
  - `docs/devcareer-prep-plugin/` — 실행 스펙 정본(`spec.md`), 이 규약 문서, 슬라이스 분할
    (`slice_plan.md`), 착수 전 게이트 체크리스트(`slice_b_spec_review.md`), 심사 기록
    (`plan_critic_findings.md`·`cold_review.md`), 스펙 입력(`SPEC_INPUT.md`).
  - `docs/handoff/` — 세션 핸드오프. **Progress Ledger가 여기 있고 그것이 에픽 연속성의 유일한
    장치**이므로 반드시 추적한다.
- **`spec.md`는 산문이 아니라 기계가 읽는 파일이다.** `samplingMethod` 정본 리터럴과 근거 배지
  리터럴의 드리프트 가드가 이 파일을 **모듈 밖 닻**으로 삼아 텍스트에서 추출한다. 옮기거나
  이름을 바꿀 때는 `scripts/lib/sampling-literal-drift.mjs`의 `SPEC_MD_REL`과 `tests/run-smoke.mjs`의
  경로 조립 지점을 함께 고쳐야 한다.
- **추적되는 코드·lint 스캔 대상이 `docs/harness/` 아래를 참조하면 안 된다.** 워킹 트리에는
  파일이 남아 있어 네 게이트가 녹색인데 **새 클론에서만 FAIL**하는 고장이 나기 때문이다.
  스모크 (DH-1)이 막으며, 금지 접두사의 정본은 `.gitignore`다.

### 이 결정이 바꾼 도구 동작 (감추지 않는다)

- **`/handoff resume`에 경로를 직접 줘라.** 경로 없는 `resume`과 `list`는 `docs/harness/handoff/`를
  보므로 승격된 핸드오프를 찾지 못한다. `/handoff generate`도 여전히 그 아래에 쓰므로, 남길
  핸드오프는 `docs/handoff/`로 옮겨 커밋한다.
- **콜드 리뷰 리포트는 로컬 전용이다.** `docs/harness/<대상 slug>/review_report.md`는 추적하지
  않는다 — 옮기면 `/deep-review`의 라운드 자동 감지가 같은 대상을 라운드 1로 다시 인식한다.
  **대가**: 새 클론에는 리포트 전문이 없다. 남는 것은 핸드오프 본문의 미반영 항목 요약이며,
  백로그로서 실제로 쓰이는 것은 그쪽이다.
