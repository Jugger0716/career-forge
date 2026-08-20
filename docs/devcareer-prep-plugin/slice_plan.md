# Slice Plan — DevCareer Prep (devcareer-prep)

> `/harness` 에픽 분할 산출물. 각 슬라이스는 **독립된 `/harness` 세션**으로 실행한다.
> 근거: `spec.md` §구현 단계, Scale Assessment `sliceHint` 후보 `foundation-first` (사용자 확정).
> `Slice` id와 `Command` 의 task 문자열은 바이트 동일하다 — 손으로 고칠 때 둘을 함께 유지할 것.

| Slice | Goal | In scope | AC ids | Depends on | Command |
|---|---|---|---|---|---|
| `slice-a-deterministic-foundation` | 결정적 기반 — 명명·라이선스 정본, JSON Schema 세트, validate-plugin.mjs(Layer 1 하네스), 결정적 픽스처 생성기, collect-git-facts.mjs(L0 수집기), verify-evidence.mjs(인용 무결성). LLM이 전혀 개입하지 않는 순수 스크립트·스키마 계층이며 단독으로 기계 검증 가능하다. | 구현 단계 1~6 · `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `LICENSE`, `README.md`, `.gitattributes`, … 외 23개 | AC-1, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-11, AC-14, AC-15, AC-17, AC-18, AC-19, AC-21 | — | `/harness "slice-a-deterministic-foundation" --output-dir docs/devcareer-prep-plugin` |
| `slice-b-p0-skill-layer` | P0 스킬 계층 — /devcareer-prep:career-from-git(범위 확정 대화·CareerWriter·2단 FactChecker·편집 병합), /devcareer-prep:skill-gap(자가진단 한정), 오염 주입 테스트, Phase 1 도그푸딩. 슬라이스 1의 스크립트를 소비만 하고 수정하지 않는다 — 단 아래 '슬라이스 A 파일 수정 예외' 표에 적힌 건만 명시적으로 허용한다. | 구현 단계 7~10 · `skills/career-from-git/SKILL.md`, `skills/career-from-git/templates/career-writer.md`, `skills/career-from-git/templates/fact-checker.md`, `scripts/render-markdown.mjs`, `scripts/lib/store.mjs`, `skills/skill-gap/SKILL.md`, … 외 11개 | AC-8, AC-9, AC-11, AC-12, AC-13, AC-14, AC-16, AC-18, AC-19, AC-20, AC-21, AC-22 | `slice-a-deterministic-foundation` | `/harness "slice-b-p0-skill-layer" --output-dir docs/devcareer-prep-plugin` |
| `slice-c-extension-and-release` | 확장·공개 — /devcareer-prep:prep-plan(Phase 3), README·아키텍처 다이어그램·예제·한계 고지, 오픈소스 공개 준비. 앞 두 슬라이스가 "쓸 만해"진 뒤에만 착수한다. | 구현 단계 11~12 · `skills/prep-plan/SKILL.md`, `skills/prep-plan/templates/curriculum-designer.md`, `schemas/plan.schema.json`, `README.md`, `examples/`, `docs/devcareer-prep-plugin/`, … 외 1개 | AC-14, AC-18, AC-19 | `slice-b-p0-skill-layer` | `/harness "slice-c-extension-and-release" --output-dir docs/devcareer-prep-plugin` |

## 슬라이스 A 파일 수정 예외 (slice-b-p0-skill-layer)

`slice-b-p0-skill-layer`는 원칙적으로 슬라이스 A의 스크립트를 **소비만 하고 수정하지 않는다.**
그러나 슬라이스 B 스펙 심사(`slice_b_spec_review.md`)와 콜드 리뷰에서 드러난 아래 항목들은
슬라이스 B가 소유할 검사·계약인데 그 코드가 살 자리가 슬라이스 A 파일이다. 예외를 여기 적지 않으면 구현자가 경계를
지키려고 사본을 만들고, 그 순간 정본이 둘로 갈린다(콜드 리뷰 A-21이 이미 같은 형태를 기록했다).

| # | 대상 파일 | 무엇을 | 근거 |
|---|---|---|---|
| 1 | `scripts/collect-git-facts.mjs` | 비공개 `writeJsonAtomic`을 공유 위치로 추출 | 구현 7단계 (d) — state/config 쓰기가 temp→rename 규약을 복사하지 않게 |
| 2 | `scripts/validate-plugin.mjs` | `--secret-scan <artifact>` 모드 추가(`ARTIFACT_SECRET_LEAK`) | 구현 7단계 (e) — AC-8 마스킹 우회 카테고리가 채점될 REJECT 사유를 만드는 유일한 지점 |
| 3 | `scripts/verify-evidence.mjs` | `basis: external`의 allow-list 대조 축 추가 | 구현 8단계 (a) — 스키마가 이미 "스크립트가 런타임에 검사한다"고 선언한 계약의 소유 파일 |
| 4 | `schemas/career.json`·`gap-report.json`·`plan.json`·`knowledge-map.json` | ① 앞 셋에 `externalUrl` 프로퍼티 + `basis:external → required` 조건절 추가 ② 네 파일 모두 「`evidence`가 비면 `basis`는 `insufficient`」 조건절을 `["insufficient","external"]`로 완화 | 예외 3번을 구현하다 **검사 대상이 생성 불가**임이 실측으로 드러났다 — 아래 근거 참조 |
| 5 | `scripts/verify-evidence.mjs` | ① 게이트 C-5 — 산출물이 1계층 이상 로드됐는데 **인용이 0건이면 `PASS`가 아니라 `INCONCLUSIVE`(exit 2)** ② A-32 — 입력 파일 오류를 raw 스택 대신 `[INPUT_ERROR]` + exit 2로 ③ A-34(이 파일 몫) — `KNOWN_LAYERS`를 export 해 `validate-plugin.mjs`의 하드코딩 사본과의 드리프트를 오라클이 관측 | 심사 C-3 수정안 ③ / 콜드 리뷰 B-1·A-32·A-34 — 아래 근거 참조 |

**이 다섯 외의 슬라이스 A 파일 수정은 여전히 금지다.**

> **예외 4번의 근거 (2026-08-19 추가).** 예외 3번(allow-list 대조 축)을 구현하고 나서
> `basis: "external"`인 노드를 만들어 보려 했더니 **어느 계층에서도 만들 수 없었다.**
> (a) `career`·`gap-report`·`plan`은 `basis` enum에 `external`을 두고도 `externalUrl`을 담을
> 프로퍼티가 없고 `additionalProperties: false`가 추가를 막는다(심사 C-4가 「강등 상태를 담을
> 필드가 정본 JSON에 없다」로 지적한 것과 같은 형태다). (b) 네 계층 모두 「`evidence`가 비면
> `basis`는 `insufficient`」 조건절에 `external` 예외가 없어, **URL 출처만 있고 커밋 근거는 없는
> 노드**를 표현할 방법이 없었다 — 없는 커밋을 달거나 `insufficient`로 강등되는 두 선택지뿐이다.
> 그 상태로 두면 예외 3번이 만든 (f)축은 **영원히 대상 0건인 검사**가 되고, 구현 8단계에서
> KnowledgeMapper가 `external` 노드를 만들려는 순간 막힌다. 사용자 확인을 받아 예외를 추가했다.
>
> **완화가 AC-12의 이빨을 깎지 않는지**를 함께 관측했다: `evidence: []` + `basis: "inference"`는
> 여전히 `enum 불일치`로 FAIL하고(세 계층 각각), `basis: "external"`이면서 `externalUrl`이 없으면
> `required 필드 'externalUrl' 없음`으로 FAIL한다. 허용 방향도 관측한다 — 커밋 근거 없이 URL
> 출처만 있는 노드가 스키마를 통과하는 것을 세 계층에서 확인한다(금지 방향만 보면 완화를 되돌려도
> 아무도 모른다).
>
> **남은 잔여 위험(닫지 않았다).** (f)축은 URL이 allow-list **소속인지만** 확인한다. URL이 실제로
> 존재하는지, 그 서술을 뒷받침하는지는 검사하지 않는다(네트워크 접근은 AC-1 「의존성 0」과 오프라인
> 전제에 걸린다). 따라서 LLM이 allow-list 안의 아무 URL이나 붙여 `insufficient` 강등을 회피하는
> 경로가 남아 있으며, 그것을 막는 것은 2단 팩트체크(`verification`, 구현 8단계 (d))뿐이다 — 즉
> **기계가 아니라 LLM 판정에 의존하는 구간**이다. 스키마 description에도 같은 문장을 적어 뒀다.

> **예외 5번의 근거 (2026-08-19 추가).** 게이트 C-5는 심사가 「T3 반영과 같은 회차에 처리하는 것이
> 싸다」고 적어 둔 채 미반영으로 남아 있었고, 그 회차는 지나갔다. 이번에 콜드 리뷰 T4(Minor 16건)와
> 묶을지를 판단하며 **T4 16건이 건드리는 파일을 실제로 셌다**: `collect-git-facts.mjs` 5건,
> `validate-plugin.mjs` 4건, `schema-validate.mjs` 3건, `run-smoke.mjs` 3건, `git.mjs` 2건,
> `make-fixture.mjs` 2건, 그 밖에 9개 파일에 각 1건. **`verify-evidence.mjs`와 겹치는 것은 16건 중
> 2건(A-32, A-34의 절반)뿐이다.** T4를 전량 지금 반영하면 예외 표가 사실상 전면 허용으로 바뀌므로,
> 사용자 확인을 받아 **이 파일 하나로 범위를 좁혔다**. 나머지 T4 14건은 그대로 미반영이며 그 사실을
> 여기 남긴다 — 「T4를 처리했다」고 읽히면 안 된다.
>
> **C-5가 닫는 구멍.** 콜드 리뷰 B-1이 지적한 두 fail-open 중 **도구 오류 쪽은 이미 닫혀 있다**
> (status 3분기 + exit 2 — 파일 헤더가 그 계약을 적고 있다). 남아 있던 것은 심사 C-3 수정안 ③의
> **「인용 0건 = PASS」** 다: 산출물이 로드됐는데 인용이 한 건도 없으면 인용 축이 **한 번도 집행되지
> 않았는데** `[PASS]` exit 0이 나왔다. C-3이 적었듯 이것은 `nodes.minItems`와 곱해질 때 가장 나쁘다 —
> **산출물이 비어 있을수록 파이프라인이 더 확실하게 녹색이 되는 구간**이 생긴다.
>
> **경계를 좁게 잡았다.** 판정은 「인용 0건」이 아니라 **「산출물이 1계층 이상 로드됐는데 인용 0건」**
> 이다. `artifactsByLayer: {}`로 부르는 호출자는 (e)축·contentHash처럼 `evidence.json` 하나로
> 성립하는 검사만 요구한 것이므로 그 경우의 PASS는 정직하다. 이 경계는 **양방향으로 관측한다** —
> 좁히는 조건(`artifactLayerCount > 0`)을 지우면 `{}` 호출이 INCONCLUSIVE로 뒤집히고, 0건 조건을
> 지우면 빈손 산출물이 다시 PASS가 된다. 두 변이가 **서로 다른 단언**을 깨는 것을 실측한다.
>
> **A-34는 이 파일 안에서만 닫는다.** 계층 enum이 `validate-plugin.mjs`에도 하드코딩돼 있는 것이
> A-34의 본체이지만 그 파일은 예외 2번(`--secret-scan`)으로만 열렸고 이 건은 그 범위 밖이다.
> 그래서 `KNOWN_LAYERS`를 export 하고 **드리프트를 소스 스캔 오라클로 관측만 한다** — 저쪽 파일은
> 고치지 않는다. 관측이 붙으면 다음에 한쪽만 바뀔 때 게이트가 빨개진다.

> **콜드 리뷰 T4 잔여 14건의 처리 회차 확정 (2026-08-19, 사용자 결정).**
> **슬라이스 C(`slice-c-extension-and-release`)로 이연한다.** 지금까지 이 14건은 "미반영"으로만
> 적혀 있어 **처리 주체도 시점도 없는 큐**였고, 핸드오프가 두 회차 연속으로 「처리 회차를 정하라」를
> 열린 항목으로 넘겼다. 이연 근거: 14건은 전부 Minor이고, 전량 반영은 슬라이스 A 파일 수정 예외
> 표를 **사실상 전면 허용**으로 바꾼다 — 그러면 이 표가 존재하는 이유가 사라진다. 반대로 파일별
> 예외를 순차로 받으면 슬라이스 B(P0 스킬 계층)의 진도가 Minor 정리에 밀린다.
>
> 대상 파일과 건수(그대로 옮긴다): `collect-git-facts.mjs` 5건, `validate-plugin.mjs` 4건,
> `schema-validate.mjs` 3건, `run-smoke.mjs` 3건, `git.mjs` 2건, `make-fixture.mjs` 2건,
> 그 밖에 9개 파일에 각 1건. **이 이연은 "처리하지 않기로 했다"가 아니라 "슬라이스 C에서
> 처리한다"이며, 슬라이스 C 착수 시 이 문단이 그 작업 목록의 입력이다.**
>
> **예외를 앞당겨 받아야 하는 유일한 경우**: 슬라이스 B 작업 중 T4 항목 하나가 **그 회차의 작업을
> 실제로 막을 때**. 그때는 예외 표에 행을 추가하고 근거를 적는다 — 예외 5번이 게이트 C-5에 대해
> 그렇게 했다. 막지 않는데 "겸사겸사" 고치는 것은 이 이연 결정을 무효로 만든다.

> **이미 발생한 슬라이스 A 수정(기록).** 슬라이스 B 착수 전 게이트 작업에서 `schemas/`(evidence·
> career·knowledge-map·gap-report), `scripts/lib/schema-validate.mjs`, `scripts/lib/lang-lint.mjs`,
> `scripts/collect-git-facts.mjs`, `tests/`가 이미 수정됐다 — 스펙 심사의 게이트 A(검증기 조건부
> 키워드 평가, `nodes.minItems`, `verification` 필드, 언어 린트 `origin` 제외)와 T3(제외 커밋 PII
> 축소)를 반영한 것이다. 이는 슬라이스 B **착수 전** 스펙·계약 개정이며 위 예외 표와는 별개다.
> 슬라이스 A의 Progress Ledger 행(`done`)이 가리키는 커밋 이후의 변경이므로, 그 행의 근거 커밋만
> 보고 현재 상태를 판단하지 마라. 그 Ledger는 이 파일이 아니라
> `docs/handoff/2026-08-18-devcareer-prep-slice-a-complete.md`에 있고, 핸드오프 문서는
> 시점 기록이라 갱신되지 않는다(HEAD·게이트 수치가 그 시점 값 그대로 남는다) — 최신 상태는
> `git log`와 `slice_b_spec_review.md`의 '반영 현황' 절을 보라.

## 자기 점검 (기계 도출)

- **구현 단계 분할**: 총 12단계 → 1..12 완전 분할, 누락 없음 · 중복 없음
- **Depends on**: 선형 체인(측정된 의존 그래프가 없어 보수적으로 직렬화). 순환 없음. 병렬 가능성은 손실되며, 사용자가 손으로 완화할 수 있다.
- **AC 매핑**: 전체 22개 중 배정 20개 · 미배정 2개 → AC-2, AC-10
- **복수 슬라이스 걸침**: AC-8 (2개 슬라이스), AC-9 (2개 슬라이스), AC-11 (2개 슬라이스), AC-14 (3개 슬라이스), AC-18 (3개 슬라이스), AC-19 (3개 슬라이스), AC-21 (2개 슬라이스) (걸침은 허용 — 누락 0건이 기준이며 중복은 공개만 한다)

### 도출 방식 공개

`In scope` 와 `AC ids` 는 LLM 판단이 아니라 `spec.md` 본문의 기계 파싱 결과다 — 구현 단계 블록의 `- 파일:` 목록과, 각 단계 서술·`- 검증 영향:` 줄에 등장하는 `AC-n` 리터럴을 추출했다.
따라서 스펙이 어떤 단계에서 AC를 명시적으로 언급하지 않았다면 그 AC는 미배정으로 남는다. 미배정 = 무관함이 아니라 **스펙이 연결을 적지 않았음**을 뜻한다.
