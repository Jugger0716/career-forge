# 오염 주입 스위트 — 사람↔스크립트 경계 정본

`spec.md` 구현 9단계와 AC-8이 요구하는 「고정 케이스 40건 × 연속 3회 × 자동 채점」의
**실행 절차 정본**이다. 케이스 파일도 채점기도 이 문서보다 **뒤에** 온다 — 경계가 고정되기
전에 채점기를 만들면 자기가 심은 문자열을 자기가 찾는 자기충족 게이트로 굳는다.

> **이 문서는 어느 가드의 스캔 집합에도 없다.** `(LN-1)`/`(LN-2)`와 `(DH-1)`의 대상은
> 추적되는 `*.mjs` + **루트** `README.md` + `CLAUDE.md` + `skills/**/*.md`이고(루트 정확
> 일치라 이 파일은 들어가지 않는다), `validate-plugin`의 AC-18 접두사 스캔은 `README.md` +
> `docs/**/*.md` + `skills/*/SKILL.md`다. 여기 적힌 명령의 접두사가 바뀌어도 경로가 사라져도
> **아무 가드가 발화하지 않는다.** 반대로 이 디렉터리에 만들 `*.mjs`는 `(LN-2)` 안이므로
> **행 번호로 다른 파일을 참조할 수 없다.**

---

## 1. 경계 — 누가 무엇을 하는가

| | 사람 | 스크립트 |
|---|---|---|
| 픽스처 재료화 | 명령을 실행한다 | — |
| 오염 산출물 생성 | **스킬을 3회 실행한다** | — |
| 회차 잔여물 배치 | `runs/<run-id>/`에 남긴다 | — |
| 탐지 판정 | **하지 않는다** | 기대 REJECT 코드와 대조해 채점 |
| 게이트 판정 | 하지 않는다 | 비율 계산·편차 경고·`results-<date>.json` 기록 |

**스크립트는 LLM을 부르지 않는다.** `tests/run-smoke.mjs`는 의존성 0의 순수 Node
스크립트이고 LLM 호출 경로가 없다. 이것이 C-1의 확정문이며 **재논의 대상이 아니다.**

**케이스별 기대 코드를 채점기 소스에 리터럴로 적지 마라.** 기대 코드의 소유자는
`cases/` 아래 케이스 파일이고, 실제 코드는 프로덕션 CLI가 스스로 뱉는다. 채점기가 둘 다
소유하면 그것이 「자기가 심은 문자열을 자기가 찾는」 구조다.

> **이 금지는 채점 경로에만 걸린다.** `tests/run-smoke.mjs`에는 이미 `CITATION_*` 리터럴이
> 25건, `ARTIFACT_SECRET_LEAK`이 2건 있다 — negative 픽스처 기대값 표가 코드를 이름 대는
> 형태다. 그것은 이 스위트의 채점 경로가 아니므로 대상이 아니다. 기준을 파일 단위로 적용하면
> 기존 파일이 통째로 자기충족으로 판정되고, 적용하지 않으면 이 기준이 아무것도 막지 못한다.

### 사람이 절차를 틀렸을 때 무엇이 FAIL하는가

| 사람의 실수 | 무엇이 잡는가 |
|---|---|
| 회차를 2회만 남김 | 회차 수 전제 단언 — 「3회 최저값」의 분모가 조용히 줄지 않는다 |
| 케이스를 고친 뒤 옛 회차를 채점 | 케이스 집합 해시 대조 — 사후 수정으로 점수를 올리는 경로를 봉쇄 |
| 회차마다 저장 루트를 안 가름 | 2·3회차가 1회차에 **병합**되어 회차 간 차이가 사라진다(§5) |
| 잔여물 일부 누락 | 「부재는 FAIL」 — 미제출은 0%가 아니라 **INVALID**다 |
| 원장 수집 옵션을 바꿔 실행 | 원장 `contentHash` 대조 — 채점기 원장과 회차 원장이 갈리면 FAIL |

---

## 2. 4종의 사정권 — 종 → 검사기 → 기대 코드

`spec.md` AC-8이 정한 4종 × 10건 = **고정 분모 40건.** 종마다 REJECT를 내는 주체가 다르고,
**그 주체는 전부 이미 존재한다** — 이 스위트가 만드는 것은 케이스와 채점기뿐이다.

| 코드 | 종 | 검사기 | 기대 REJECT | 채점에 LLM 필요 |
|---|---|---|---|---|
| `FH` | 원장에 없는 가짜 해시 10 | `scripts/verify-evidence.mjs` | `CITATION_COMMIT_NOT_FOUND_IN_REPO` · `CITATION_MALFORMED_LEDGER_ID` | 아니오 |
| `OA` | 타 저자·봇 커밋 인용 10 | `scripts/verify-evidence.mjs` | `CITATION_EXCLUDED_COMMIT` — `exclusionReason`이 `bot-pattern` / `author-not-selected` 중 어느 쪽인지까지 대조 | 아니오 |
| `SB` | 마스킹 우회 시크릿 10 | `scripts/validate-plugin.mjs --secret-scan` | `ARTIFACT_SECRET_LEAK` | 아니오 |
| `UC` | 근거 없는 주장 10 | **FactChecker(LLM)** | 반증 판정 → 항목 강등 | **예** |

> **`CITATION_AUTHOR_NOT_SELECTED`는 이 스위트의 기대 코드가 아니다.** §4가 고정한 argv
> (`--identity owner@devcareer-fixture.test`, `--all-identities` 없음)로 수집하면 타 저자
> 커밋도 봇 커밋도 전부 `excluded: true`로 원장에 박히고, `verifyCitation`은 `excluded`
> 검사에서 먼저 반환하므로 그 코드에 **도달하지 않는다.** 그 코드는 `--all-identities`로
> 수집한 원장이나 스테일 원장에서만 난다 — §4가 그 상황을 명시적으로 배제한다.

**`FH`·`OA`·`SB` 세 종은 결정적이고 채점에 LLM이 필요 없다.** AC-8 (iv)가 그 경계를 요구한다.
케이스를 **만드는** 시점의 손 주입은 별개이며 §2-3이 따로 적는다.

### 2-1. `OA` 10건은 봇 축을 포함한다 — 대조군으로 빼지 마라

AC-9가 「선택되지 않은 저자의 커밋과 **봇 커밋**(`[bot]`, dependabot, github-actions)이
산출물에 0건 혼입된다 … `tests/contamination`의 '타 저자 커밋 인용' 10건으로 관측된다」로
**이 10건을 자기 관측자로 지목한다.** 봇을 분모 밖 대조군으로 빼면 AC-9의 절반이 관측되지
않는다. 300커밋 픽스처에 봇 20건·타 저자 30건이 실재하므로 재료는 있다.

**주의 — 한 코드로 뭉개진다.** `OA`의 실제 두 갈래인 **봇 제외(`bot-pattern`)**와
**타 저자 제외(`author-not-selected`)**가 같은 `excluded: true` 플래그를 공유하고,
`verifyCitation`은 `excluded` 검사를 저자 검사보다 **먼저** 하므로 둘 다
`CITATION_EXCLUDED_COMMIT` 하나로 떨어진다. 따라서 `OA` 케이스는 **코드 단독으로 채점하지
않고** 원장의 `exclusionReason`으로 보강 대조한다 — 그러지 않으면 「봇을 잡았다」와
「타 저자를 잡았다」가 같은 점수가 된다.

> `classifyExclusion`이 내는 값은 다섯이지만(`shallow-boundary`·`period-out-of-range`·
> `bot-pattern`·`author-not-selected`·`merge-excluded`), 이 스위트에서 실제로 나는 것은
> 위 둘뿐이다 — §4의 argv에 `--since`/`--until`이 없어 기간 축은 0건이고, 머지 축은 §4가
> 이 분모 밖으로 뺐다.

### 2-2. `FH` 10건이 서로 달라야 할 축 — 리터럴 10개는 같은 케이스의 10배다

인용은 `{ledgerId, path?}` 형태이고 `ledgerId`는 `evidence.json`의 `commits[].id`다.
`extractShaCandidate`가 `commit:<40자 소문자 hex>`와 순수 `<40자 소문자 hex>` 둘 다 받는다.
**세 축**으로 가른다:

1. **형식** — `commit:` 접두 / 순수 hex. 둘 다 추출을 통과해 (b)축까지 가서
   `CITATION_COMMIT_NOT_FOUND_IN_REPO`로 떨어진다.
2. **형식 위반** — 39자·41자·대문자 혼입·비-hex·빈 문자열 → 추출 자체가 실패해
   `CITATION_MALFORMED_LEDGER_ID`로 **다른 코드**가 난다.
3. **계층** — `career` / `knowledge-map`·`gap-report`. L2·L3의 `basis` enum에는 `commit`이
   **없으므로**(`inference`·`external`·`insufficient`뿐) 인용의 성격 자체가 다르다.

**축이 아닌 것 둘 — 헷갈리기 쉬워 적어 둔다.**

- **`path` 동반 여부는 축이 아니다.** `verifyCitation`의 `if (citationPath)` 블록은 함수의
  **마지막** 검사이고, 그 앞의 조기 반환을 **전부 통과해야만** 도달한다. 가짜 해시는 정의상
  앞의 두 검사 중 하나에서 반드시 나가므로 `path`를 붙이든 말든 결과 코드가 같다(실측: 같은
  가짜 해시를 `path` 없음 / 실존 경로 / 없는 경로 세 형태로 넣어도 전부
  `CITATION_COMMIT_NOT_FOUND_IN_REPO` 하나였다). `CITATION_PATH_*`는 (a)(b)와 저자 검사를
  모두 통과한 **정상 인용**에 거짓 경로를 붙였을 때만 나며, 그것은 `FH`가 아니라 별개 종이다.
- **「레포엔 있으나 원장엔 없음」도 축이 아니다.** §4가 `--max-commits 1000`(절단 없음)으로
  확정한 순간 순회한 300건이 전부 원장에 남는다(비제외는 선택 집합으로, 제외는 예산과 무관하게
  전량 등재). 그러면 「레포에는 있는데 원장에는 없는」 해시를 만들 수 없고,
  `CITATION_LEDGER_ENTRY_NOT_FOUND`는 이 스위트에서 **한 건도 산출되지 않는다.** 그래서 §2
  표의 `FH` 기대 코드에서 뺐다.

### 2-3. `SB` 10건은 300커밋 원장 밖이다 — 그 예외를 여기 선언한다

`spec.md` 9단계는 「40건은 300커밋 픽스처 위에서 수집한 원장을 대상으로 주입한다」로 4종
전부를 그 원장에 묶는다. **`SB`만은 그럴 수 없다** — `buildLarge300`에는 시크릿이 한 건도
없고, 시크릿은 `buildSecrets`·`buildSecretsInCommitMetadata`라는 **별개 시나리오**에만 있다.
따라서 `SB` 10건은 산출물 자유 서술 필드에 손으로 주입하며, 이 이탈을 여기 기록한다.

**두 축을 갈라 적는다.** AC-11의 「픽스처에 심어둔 가짜 API 키가 어떤 산출물에도 포함되지
않는다」는 **수집 시점 마스킹** 축이고, `SB`는 **산출물 시점 스캔** 축이다.

**탐지 사각지대를 케이스로 쓰지 마라(실측 — 임시 산출물로 `--secret-scan`을 직접 돌려 확인).**
다음 셋은 `[PASS]` exit 0이 난다:

- **순수 소문자 40자 hex** — `aws-secret-key` 정규식이 커밋 SHA 오탐을 피하려 선행 부정
  탐색으로 명시적으로 제외한다. 대문자가 하나라도 섞이면 오히려 잡힌다.
- **40자가 아닌 고립된 연속 영숫자 런**(41·50·60자 실측 미탐). **「길기만 하면 안전하다」로
  읽지 마라** — 더 긴 문자열이라도 그 안의 40자 창이 비단어 문자(`/`·`.`·`"` 등)로 잘려
  들어 있으면 잡힌다(실측: `abc/<40자>/def`는 REJECT된다).
- **`[REDACTED:...]` 리터럴을 담은 「이미 마스킹된 척」 문자열** — `password-field`의 값 문자
  집합이 대괄호를 배제하고 나머지 키 패턴에도 대괄호가 없다. **단 `private-key-block`은
  예외다** — 그 패턴은 무엇이든 삼키므로 PEM 마커에 감싸인 `[REDACTED:...]`는 잡힌다(실측).

「10건 모두 REJECT된다」가 전제이므로 위 형태는 **케이스가 아니라 음성 대조**로만 쓴다.

**파일명이 레이어를 정한다.** `--secret-scan`은 `<파일명>.json`을 `schemas/<파일명>.schema.json`에
대응시킨다. 이름이 7종(`career`·`config`·`evidence`·`gap-report`·`knowledge-map`·`plan`·`state`)
중 하나와 정확히 일치하지 않으면 `SECRET_SCAN_SCHEMA_NOT_FOUND`가 나고 **기대 코드가 어긋난다**
(실측 확인).

### 2-4. `UC` 10건은 두 FactChecker에 나눠 싣는다

반증 프롬프트는 이제 **둘**이다 — `skills/career-from-git/templates/fact-checker.md`(career)와
`skills/skill-gap/templates/gap-fact-checker.md`(knowledge-map·gap-report를 한 번에 본다).
`UC`를 career 한 계층에 몰면 「FactChecker 실효성의 유일한 측정 수단」이 방금 만든
GapFactChecker를 **한 번도 재지 않는다.** 그래서 **career 5건 + L2/L3 5건**으로 나눈다.
이것이 회차마다 `skill-gap`을 함께 돌리는 이유이기도 하다.

---

## 3. 모드 — 무엇이 `npm test`에 들어가는가

**사용자 결정(D6): `npm test`에는 기계 3종만 넣는다.**

| 명령 | 대상 | `runs/` | `npm test` |
|---|---|---|---|
| `node tests/run-smoke.mjs --contamination` | `FH`·`OA`·`SB` 30건 + 구조 가드 | **필수** | 다섯 번째 게이트(**선행 조건 있음**) |
| `node tests/run-smoke.mjs --contamination-llm` | `UC` 10건 × 3회 집계 | **필수** | 아니오 |

**두 모드 다 `runs/`를 읽는다.** AC-8 (ii)가 「`--contamination`은 `tests/contamination/runs/<run-id>/`에
놓인 산출물 세트를 읽어 채점만 한다」로 못 박았고, 구현 9단계도 같은 배선을 반복한다.
AC-8 (iv)가 허가한 것은 「LLM 없이 채점된다 / 단독으로 돌 수 있다」이지 **「회차 산출물 없이
채점된다」가 아니다.** §1·§7의 잔여물 표가 그 전제 위에 서 있다 — 저자 대조 축은
`config.json`을, 인용 대조는 회차 `evidence.json`을 읽는다.

**스펙 조항과 갈린 지점은 플래그 분할 하나뿐이다.** AC-8 본문은 `--contamination` 하나가
40건을 채점한다고 적는다. 여기서 둘로 나눈 것은 D6의 이행이며, `UC`를 `--contamination`의
「미채점」으로 두지 않는다 — 그것은 부재를 강등하는 형태다(절대 규칙 6). `UC`는 그 모드의
**범위 밖**이고, `--contamination-llm`에서 `runs/` 부재는 **FAIL**이다.

> **D6의 근거가 결정 당시와 달라졌다 — 감추지 않는다.** 결정 시점에 제시된 근거는
> 「기계 축은 `runs/` 없이도 항상 녹색이라 `npm test`에 넣어도 썩지 않는다」였고 **그 전제는
> 거짓이었다.** 결정 자체는 유지되지만 이제 **D5에 의존한다** — `runs/`를 추적하므로 새
> 클론에도 회차 산출물이 있고, 그래서 `npm test`가 녹색일 수 있다.

**`npm test` 편입에는 절차적 선행이 있다.** `package.json`은 `slice_plan.md`의
`slice-a-deterministic-foundation` In scope 열에 이름으로 박힌 **슬라이스 A 파일**이고
「슬라이스 A 파일 수정 예외」 표 다섯 행 어디에도 없다. 따라서 예외 표에 행을 추가하고 근거를
적기 전까지 이 모드는 다섯 번째 게이트가 아니라 **단독 실행 게이트**다. 예외는 「그 항목이
회차 작업을 실제로 막을 때만」 추가한다(절대 규칙 5) — 모드 자체는 `package.json` 없이 만들 수
있으므로 지금은 막지 않는다. (`tests/run-smoke.mjs`는 슬라이스 B 파일이라 모드 추가에는
예외가 필요 없다.)

**두 모드 다 `EXPECTED_ASSERTIONS_BEFORE_GUARDS`에 자기 키가 필요하다** — `finishMode`가
키를 찾지 못하면 `expected`가 `undefined`가 되어 비교가 항상 거짓이 되고 무조건 FAIL한다.

**단언 개수는 케이스 수와 무관해야 한다.** 구현 9단계는 편차 20%p 초과 시 종당 20건으로 1회
증설을 허용한다. 케이스마다 단언을 세우면 **케이스 파일 수(데이터)를 바꿀 때마다 정본 상수
(소스 리터럴)를 함께 고쳐야 한다** — 절대 규칙 4가 의도한 마찰을 채점 데이터에 매다는 형태다.
충돌이 아니라 결합이고, 그 결합을 만들지 않는다. 채점은 **집계 단언**으로 관측하고 케이스별
판정은 `results-<date>.json`에 기록한다.

---

## 4. 원장 수집 옵션 — 게이트 C-4가 「남은 공백」으로 남긴 항목

게이트 C-4는 기반 픽스처를 300커밋으로 확정하면서 「**남은 공백**: 40건 원장의 수집 옵션
(선택 identity 집합·머지 포함 여부)은 못 박혀 있지 않다」를 남겼다. 여기서 닫는다:

```sh
node scripts/collect-git-facts.mjs \
  --repo   <픽스처>/large300 \
  --ref    HEAD \
  --identity owner@devcareer-fixture.test \
  --max-commits 1000 \
  --out    <회차 저장 루트>/.devcareer
```

실측 결과: `traversed=300` / `total=245` / `dropped_commits=0` / `truncated.reason="none"`,
`exclusionReason` 분포 `{bot-pattern: 20, author-not-selected: 30, merge-excluded: 5}`.

각 값의 근거:

- **`--identity`를 반드시 명시한다. `--all-identities`는 쓰지 않는다.** 이유가 둘인데
  **흔히 오해되는 쪽부터 적는다.**

  (i) `--all-identities`는 타 저자 인용을 **놓치게 만들지 않는다.** `CITATION_AUTHOR_NOT_SELECTED`
  축은 원장의 `excluded` 플래그가 아니라 **git이 실측한 저자**를 선택 집합과 대조하는 독립
  검사다(스테일 원장 방어). 그 플래그가 하는 일은 탐지를 없애는 것이 아니라 **기대 코드를
  바꾸는 것**이다 — `CITATION_EXCLUDED_COMMIT`이 나올 자리에 `CITATION_AUTHOR_NOT_SELECTED`가
  난다(실측 확인). 케이스가 코드로 채점되므로 그것만으로 `OA` 10건 중 **타 저자 축** 케이스가
  오답 처리된다. **봇 축은 그 플래그 아래에서도 기대 코드가 바뀌지 않는다** — 봇 판정이
  저자 판정보다 앞서 확정되기 때문이다.

  (ii) 단독으로 쓰면 `coverage.exclusions.selectedIdentities`가 **빈 배열**로 박히고
  L1+ 산출물이 그 값을 그대로 복사한다(실측). 「어느 범위 위에서 만든 산출물인가」를 원장
  스스로 말하지 못하게 된다.

  덧붙여 `--all-identities`는 `author-not-selected` 축을 무력화하는데, `classifyExclusion`의
  우선순위상 **그 뒤에 오는 머지 축까지 함께 꺼진다** — 선택 집합이 비면 소유자 머지 커밋도
  먼저 `author-not-selected`로 분류되어 되돌리는 분기에 삼켜진다. 앞에 오는 shallow·기간·봇
  축만 남는다.

- **머지 포함 플래그를 쓰지 않는다**(기본 = 머지 제외). 오염 40건에 머지 축은 없다 —
  머지 해시 인용은 case (17)이고 `spec.md`가 **이 분모에 산입하지 않는다**고 명시했다.
- **`--max-commits 1000`(기본, 절단 없음).** 절단이 걸리면 실재 커밋이 원장에서 빠져
  「레포엔 있으나 원장엔 없는」 상태가 생기는데, 그것은 §2-2가 축에서 뺀 형태다. 절단은
  AC-21의 몫이지 이 스위트의 몫이 아니다.
- **`--out`으로 저장 루트를 명시하고, 그 경로에 `.devcareer` 세그먼트를 반드시 넣는다**(§5-c).

---

## 5. 사람의 준비물 — 「3회 실행」을 성립시키는 다섯 가지

### (a) 픽스처 재료화

```sh
node fixtures/make-fixture.mjs --out <픽스처>
```

전 시나리오를 만들고 정리하지 않는다. 이 스위트가 쓰는 것은 `<픽스처>/large300`이다.
픽스처는 완전 결정적이다 — 날짜·이름·이메일을 고정하고 GPG 서명·autocrlf를 끄며
`Date.now()`/`Math.random()`을 쓰지 않는다(AC-5).

> **하드코딩한 해시는 `make-fixture.mjs`에 묶인다.** 생성기가 바뀌면 해시가 갈린다.
> 그래서 케이스는 **셀렉터를 정본**으로 삼고 하드코딩 해시는 드리프트 앵커로만 쓴다.
>
> **실측 주의**: Git Bash에서 이 명령을 돌리면 한글 경로 `git mv`가 `destination exists`로
> 죽는 사례가 관측됐다. PowerShell에서는 성공했다.

### (b) 플러그인 설치

`.claude-plugin/marketplace.json`이 실재하므로 로컬 마켓플레이스로 추가한다. 실제로 노출되는
명령 접두사가 `devcareer-prep:`인지 **육안 확인**한다(AC-18).

### (c) 회차마다 저장 루트를 가른다 — 안 가르면 2·3회차가 1회차에 병합된다

저장 루트는 `~/.devcareer/<repo-key>/`이고 `<repo-key>`는 **레포 경로에서 파생**된다. 같은
픽스처 경로로 3회를 돌리면 세 회차가 같은 루트를 쓰고, `mergeArtifact`가 `locked` 노드를
보존하며 draft 단계에서 `verification`을 이월한다 — **회차 간 독립이 사라진다.** 「3회
최저값」이 3회 누적값이 되면 그 수치는 아무것도 뜻하지 않는다.

두 수단 중 하나를 쓴다:

1. **회차마다 저장 루트를 다르게 준다.** 그 경로에는 **`.devcareer` 세그먼트가 반드시
   있어야 한다**(예: `<회차 베이스>/run-<n>/.devcareer`) — `store.mjs`의 저장 경계 검사가
   세그먼트 없는 경로를 위반으로 판정하고 `write-artifact.mjs`·`write-config.mjs`·
   `project-ledger.mjs`·`read-registry.mjs`가 exit 2로 죽는다. **수집기만은 이 검사를 하지
   않으므로 잘못 고르면 수집은 exit 0으로 통과하고 산출물 단계에서 처음 죽는다.**
   인자 이름도 도구마다 다르다 — 수집기는 `--out`, 나머지 넷은 `--root`다.
   다만 `skills/career-from-git/SKILL.md` 1단계 명령 블록은 `--out`을 노출하지 않으므로,
   이 수단을 쓰려면 SKILL.md를 함께 고쳐야 한다.
2. **회차 사이에 저장 루트를 삭제한다** — SKILL.md를 고치지 않는다면 이쪽이 권장이다.

### (d) 자가진단 고정 입력

`skill-gap` 5단계는 사용자 자가진단을 **사람에게서 받고 「지어내지 마라」가 규약**이다
(`gapNode`의 `selfAssessment`는 노드마다 required다). 회차마다 다른 값을 넣으면 `gap-report`가
회차마다 갈려 `UC` 판정의 편차가 케이스 때문인지 입력 때문인지 구별되지 않는다. **세 회차에
같은 원문을 넣는다** — 그 원문을 `runs/self-assessment.md`에 고정한다.

### (e) 0단계 범위 확정 대화의 `config` 값

`config.schema.json`의 최상위 required는 9개지만, 그중 `schemaVersion`·`updatedAt`은
`write-config.mjs`가 스스로 찍는 필드이고 입력에 담아도 덮어써진다. **사용자가 대화에서
확정할 것은 나머지 일곱**(`identitySelection`·`scope`·`budget`·`includeDiff`·`exclusions`·
`storage`·`snippetQuoting`)이며, 그 일곱은 스키마에 default가 있어도 이 CLI가 채우지 않고
`[INPUT_ERROR]` + exit 2로 거부한다(절대 규칙 6). §4의 argv와 **같은 값**을 확정해야 회차
원장과 채점기 원장이 갈리지 않는다.

---

## 6. 3회는 직렬이다

**병렬 세션으로 단축하지 마라.** 작업 순서 15번(`state.json` 레지스트리 RMW 동시성 제어)이
스스로 「**14번이 병렬 실행을 택하거나** 도그푸딩이 여러 세션으로 가는 순간 앞으로 당긴다 —
그때 잃는 것은 픽스처가 아니라 실제 산출물 레지스트리 항목이다」라고 적었다. 병렬을 택하는
순간 15번이 14번의 **하드 선행**이 되어 착수 순서가 바뀐다.

---

## 7. 회차 잔여물 — `runs/<run-id>/`

**사용자 결정(D5): 이 디렉터리를 git으로 추적한다.** 회차 산출물은 **픽스처** 위에서 나오므로
실물 PII가 없다(저자는 `owner@devcareer-fixture.test` 등 허구다). 추적해야 CLAUDE.md가 요구하는
「커밋 뒤 새 클론에서 한 번 더 확인한다」가 이 게이트에 대해 성립하고, `--contamination`이
`npm test`에 들어갈 수 있다(§3).

> **실레포 산출물을 여기 넣지 마라.** `.gitignore`의 `.devcareer/` 항목이 그 범주를
> 「개인 경력 데이터·실제 커밋 해시·PII가 담기므로 public 레포에 커밋 대상이 아니다」로
> 적었다. 이 예외는 **픽스처 산출물에 한정**된다.

각 회차가 남겨야 하는 것:

| 잔여물 | 없으면 |
|---|---|
| `evidence.json`(회차 원장) | 인용을 대조할 원장이 없다 → INVALID |
| `config.json` | 저자 대조 축의 정본이 없다 → INVALID |
| `career.json` · `knowledge-map.json` · `gap-report.json` | 해당 계층 케이스가 미제출 → INVALID |
| 렌더된 `.md` 3종 | AC-13의 강등 배지 축이 관측되지 않는다 |
| `manifest.json`(회차 메타) | 케이스 집합 해시·수집 argv·회차 순번·모델 티어 기록이 없다 → INVALID |

**미제출은 0%가 아니다.** 판정 어휘는 `DETECTED` / `MISSED` / `INVALID` /
`RESOLVED_BY_REGENERATION` 넷이고, **분모는 언제나 케이스 파일 개수로 고정**한다.
`results-<date>.json`에 `denominator` · `detected` · `missed` · `invalid` 네 수를 함께 적어
비율이 어떻게 나왔는지가 사후에 재계산 가능하게 한다. **분모를 「채점된 건수」로 바꾸는 것이
이 게이트를 무력화하는 가장 싼 방법이다.**

`RESOLVED_BY_REGENERATION`은 반증이 성공해 재생성으로 노드가 사라지거나 고쳐진 경우다 —
`DETECTED`의 정상적 귀결이므로 탐지로 센다. 「노드가 없다」를 미탐지로 읽으면 **반증이 가장
잘 작동한 회차가 가장 낮은 점수를 받는다.**

---

## 8. 게이트 판정

- **기계 3종**: 3회 모두 **종당 100%**.
- **LLM 1종(`UC`)**: 3회 **최저값 80% 이상**. 재실행해 나온 최고값을 근거로 쓰지 않는다.
- **회차 편차 20%p 초과**: FAIL이 아니라 **지표 신뢰도 경고**. 종당 20건으로 **1회에 한해**
  증설한 뒤 동일 **비율** 기준으로 재판정한다. 증설 후에도 20%p를 넘으면 FAIL로 확정하고
  FactChecker 프롬프트를 고친다. **증설을 근거로 재실행 최고값을 채택하는 경로는 금지다.**

---

## 9. 선언된 한계 — 감추지 않는다

- **검사기는 쓰기 뒤에 온다 — 오염 산출물은 실재한다.** 두 SKILL.md는 산출물을 **먼저 쓰고**
  검사기를 나중에 돌린다(career: 4·6단계 쓰기 → 7단계 `verify-evidence` → 8단계
  `--secret-scan`. skill-gap: 4·6·7단계 쓰기 → 8단계 → 9단계). 검사기는 이미 디스크에 있는
  파일을 읽는 **사후 검사**이므로 FAIL해도 오염 산출물은 저장 루트에 그대로 남는다 —
  멈추는 것은 **절차**이지 **쓰기**가 아니다. 기계 30건을 회차 산출물 위에서 관측할 수 있는
  근거가 바로 이것이고, 동시에 사람이 그 파일을 `runs/`로 옮기지 않으면 아무것도 관측되지
  않는다는 뜻이기도 하다.
  덧붙여 「exit 1이나 exit 2면 보고하고 **멈춘다**」가 못 박힌 것은 **`verify-evidence`
  단계뿐**이다. `--secret-scan` 단계는 명령 블록 한 줄뿐이고 종료 코드 지시가 없다 —
  `SB` 축에 대해서는 절차상 멈춤 자체가 규정돼 있지 않다.
- **모델 티어를 디스패치에 넘기는 수단이 없다.** 「명시했는가」는 관측된다 —
  `(SP-7)`이 `/templates/` 아래 프롬프트 전량에 「티어」·「세션 모델」 문구를 요구하고 하나라도
  빠지면 FAIL한다. 관측되지 않는 것은 **「그 티어로 실제로 띄웠는가」**이고, 레포에 `agents/`
  디렉터리도 티어 인자도 없다. `UC`의 80% 게이트가 이 티어 위에 서 있으므로 `manifest.json`에
  **기록으로 남기는 것이 전부**이며, 그 수치의 재현성은 그만큼만 보장된다.
- **`--stage fact-checked`는 라벨이다.** FactChecker를 실제로 돌렸는지를 기계가 구별하지 못한다.
- **`contentHash`는 키 없는 SHA-256이다.** 우발적 드리프트는 잡지만 의도적 위조는 막지 못한다.
- **`--secret-scan`은 렌더된 `.md`를 보지 않는다.** JSON 산출물만 대상이며, `.md`가 안전한
  것은 「렌더러가 JSON 값을 그대로 뷰잉만 한다」는 **계약 의존**이지 증명이 아니다
  (`secret-scan.mjs` 머리말이 같은 말을 먼저 적었다).
- **`UC` 판정은 3회 표본이다.** 전부 refuted하는 FactChecker도 100%를 얻는다 — 음성 대조
  없이는 「반증 능력」과 「무조건 거부」가 구별되지 않는다. 대조군을 분모 밖에 별도로 둔다.
- **이 문서가 세운 규범 중 아직 코드가 없는 것**: §7의 판정 어휘·`results` 필드와 §8의 게이트
  배선. 케이스도 채점기도 없으므로 지금은 스펙과 어긋나지 않는다는 것까지만 확인됐다.
