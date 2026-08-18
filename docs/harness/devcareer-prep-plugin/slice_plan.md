# Slice Plan — DevCareer Prep (devcareer-prep)

> `/harness` 에픽 분할 산출물. 각 슬라이스는 **독립된 `/harness` 세션**으로 실행한다.
> 근거: `spec.md` §구현 단계, Scale Assessment `sliceHint` 후보 `foundation-first` (사용자 확정).
> `Slice` id와 `Command` 의 task 문자열은 바이트 동일하다 — 손으로 고칠 때 둘을 함께 유지할 것.

| Slice | Goal | In scope | AC ids | Depends on | Command |
|---|---|---|---|---|---|
| `slice-a-deterministic-foundation` | 결정적 기반 — 명명·라이선스 정본, JSON Schema 세트, validate-plugin.mjs(Layer 1 하네스), 결정적 픽스처 생성기, collect-git-facts.mjs(L0 수집기), verify-evidence.mjs(인용 무결성). LLM이 전혀 개입하지 않는 순수 스크립트·스키마 계층이며 단독으로 기계 검증 가능하다. | 구현 단계 1~6 · `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `LICENSE`, `README.md`, `.gitattributes`, … 외 23개 | AC-1, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-11, AC-14, AC-15, AC-17, AC-18, AC-19, AC-21 | — | `/harness "slice-a-deterministic-foundation" --output-dir docs/harness/devcareer-prep-plugin` |
| `slice-b-p0-skill-layer` | P0 스킬 계층 — /devcareer-prep:career-from-git(범위 확정 대화·CareerWriter·2단 FactChecker·편집 병합), /devcareer-prep:skill-gap(자가진단 한정), 오염 주입 테스트, Phase 1 도그푸딩. 슬라이스 1의 스크립트를 소비만 하고 수정하지 않는다 — 단 아래 '슬라이스 A 파일 수정 예외' 3건은 명시적으로 허용한다. | 구현 단계 7~10 · `skills/career-from-git/SKILL.md`, `skills/career-from-git/templates/career-writer.md`, `skills/career-from-git/templates/fact-checker.md`, `scripts/render-markdown.mjs`, `scripts/lib/store.mjs`, `skills/skill-gap/SKILL.md`, … 외 11개 | AC-8, AC-9, AC-11, AC-12, AC-13, AC-14, AC-16, AC-18, AC-19, AC-20, AC-21, AC-22 | `slice-a-deterministic-foundation` | `/harness "slice-b-p0-skill-layer" --output-dir docs/harness/devcareer-prep-plugin` |
| `slice-c-extension-and-release` | 확장·공개 — /devcareer-prep:prep-plan(Phase 3), README·아키텍처 다이어그램·예제·한계 고지, 오픈소스 공개 준비. 앞 두 슬라이스가 "쓸 만해"진 뒤에만 착수한다. | 구현 단계 11~12 · `skills/prep-plan/SKILL.md`, `skills/prep-plan/templates/curriculum-designer.md`, `schemas/plan.schema.json`, `README.md`, `examples/`, `docs/harness/devcareer-prep-plugin/`, … 외 1개 | AC-14, AC-18, AC-19 | `slice-b-p0-skill-layer` | `/harness "slice-c-extension-and-release" --output-dir docs/harness/devcareer-prep-plugin` |

## 슬라이스 A 파일 수정 예외 (slice-b-p0-skill-layer)

`slice-b-p0-skill-layer`는 원칙적으로 슬라이스 A의 스크립트를 **소비만 하고 수정하지 않는다.**
그러나 슬라이스 B 스펙 심사(`slice_b_spec_review.md`)에서 드러난 세 항목은 슬라이스 B가 소유할
검사·계약인데 그 코드가 살 자리가 슬라이스 A 파일이다. 예외를 여기 적지 않으면 구현자가 경계를
지키려고 사본을 만들고, 그 순간 정본이 둘로 갈린다(콜드 리뷰 A-21이 이미 같은 형태를 기록했다).

| # | 대상 파일 | 무엇을 | 근거 |
|---|---|---|---|
| 1 | `scripts/collect-git-facts.mjs` | 비공개 `writeJsonAtomic`을 공유 위치로 추출 | 구현 7단계 (d) — state/config 쓰기가 temp→rename 규약을 복사하지 않게 |
| 2 | `scripts/validate-plugin.mjs` | `--secret-scan <artifact>` 모드 추가(`ARTIFACT_SECRET_LEAK`) | 구현 7단계 (e) — AC-8 마스킹 우회 카테고리가 채점될 REJECT 사유를 만드는 유일한 지점 |
| 3 | `scripts/verify-evidence.mjs` | `basis: external`의 allow-list 대조 축 추가 | 구현 8단계 (a) — 스키마가 이미 "스크립트가 런타임에 검사한다"고 선언한 계약의 소유 파일 |

**이 셋 외의 슬라이스 A 파일 수정은 여전히 금지다.**

> **이미 발생한 슬라이스 A 수정(기록).** 슬라이스 B 착수 전 게이트 작업에서 `schemas/`(evidence·
> career·knowledge-map·gap-report), `scripts/lib/schema-validate.mjs`, `scripts/lib/lang-lint.mjs`,
> `scripts/collect-git-facts.mjs`, `tests/`가 이미 수정됐다 — 스펙 심사의 게이트 A(검증기 조건부
> 키워드 평가, `nodes.minItems`, `verification` 필드, 언어 린트 `origin` 제외)와 T3(제외 커밋 PII
> 축소)를 반영한 것이다. 이는 슬라이스 B **착수 전** 스펙·계약 개정이며 위 예외 표와는 별개다.
> 슬라이스 A의 Progress Ledger 행(`done`)이 가리키는 커밋 이후의 변경이므로, 그 행의 근거 커밋만
> 보고 현재 상태를 판단하지 마라.

## 자기 점검 (기계 도출)

- **구현 단계 분할**: 총 12단계 → 1..12 완전 분할, 누락 없음 · 중복 없음
- **Depends on**: 선형 체인(측정된 의존 그래프가 없어 보수적으로 직렬화). 순환 없음. 병렬 가능성은 손실되며, 사용자가 손으로 완화할 수 있다.
- **AC 매핑**: 전체 22개 중 배정 20개 · 미배정 2개 → AC-2, AC-10
- **복수 슬라이스 걸침**: AC-8 (2개 슬라이스), AC-9 (2개 슬라이스), AC-11 (2개 슬라이스), AC-14 (3개 슬라이스), AC-18 (3개 슬라이스), AC-19 (3개 슬라이스), AC-21 (2개 슬라이스) (걸침은 허용 — 누락 0건이 기준이며 중복은 공개만 한다)

### 도출 방식 공개

`In scope` 와 `AC ids` 는 LLM 판단이 아니라 `spec.md` 본문의 기계 파싱 결과다 — 구현 단계 블록의 `- 파일:` 목록과, 각 단계 서술·`- 검증 영향:` 줄에 등장하는 `AC-n` 리터럴을 추출했다.
따라서 스펙이 어떤 단계에서 AC를 명시적으로 언급하지 않았다면 그 AC는 미배정으로 남는다. 미배정 = 무관함이 아니라 **스펙이 연결을 적지 않았음**을 뜻한다.
