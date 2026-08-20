# 콜드 리뷰 리포트 — devcareer-prep 플러그인 (career-forge)

> **이 리뷰는 앵커 없이(anchor-free) 수행됐다.**
> 5개 렌즈(정확성 / 구조·유지보수성 / 견고성·리소스 / 보안·프라이버시 / 계약 일관성)의 리뷰어와 적대적 반증 검증자 모두
> `docs/devcareer-prep-plugin/`의 `spec.md`·`plan_critic_findings.md`·`slice_plan.md`·`SPEC_INPUT.md`와 `.harness/`를 **열지 않았다**.
> 즉 이 리포트의 모든 지적은 "코드·스키마·README·테스트만 읽고, 실제로 실행해 재현한 것"에 근거하며,
> **설계 문서에서 이미 의도적으로 결정했거나 후속 구현 단계(skills 계층)의 몫으로 미룬 사항을 결함으로 오인한 항목이 섞여 있을 수 있다.**
>
> 그 위험이 큰 항목은 `B. may-be-intentional` 섹션으로 분리했으니 설계 문서와 대조해 트리아지하라.
> `A. context-independent` 섹션 항목들은 "어떤 설계 의도를 가정해도 결함"이라고 판단한 것들이며, 대부분 코드베이스 **내부 자기모순**
> (스키마가 선언한 계약 ↔ 코드 동작, 주석이 선언한 단일 정본 ↔ 실제 사본 개수)이거나 실행 재현으로 관측된 오동작이다.
> 그럼에도 A 섹션 역시 100% 확실하다고 주장하지 않는다 — 특히 미구현 상위 계층(skills)이 소유하기로 계획된 검증·게이트가 있다면
> A-7, A-16, A-18의 범위는 축소될 수 있다.
>
> 검증 환경: Windows 11 / git 2.47 / Node v24.15.0. 원본 레포는 수정하지 않았고 재현은 전부 스크래치패드 사본에서 수행했다.

## Summary: Critical=5, Major=20, Minor=16

---

## 우선순위 요약 (먼저 볼 5건)

| # | 항목 | 왜 먼저인가 |
|---|---|---|
| 1 | A-1 `T`(typechange) 파서 예외 | 커밋 1건으로 수집·검증 전체가 죽고 산출물이 0건. 흔한 레포에서 도구를 아예 못 쓴다. |
| 2 | B-1 verify-evidence fail-open | `--repo` 오타 하나로 "검증 0건 → `[PASS]` exit 0". 이 제품의 유일한 집행 지점이 무력화된다. |
| 3 | A-3 shallow clone 경계 커밋 | 도구가 스스로 "단일 커밋 20만 줄 신규 작성"이라는 정량 과장을 만들고 스스로 승인한다(실측 4.2배). |
| 4 | B-2 제외 커밋 PII 전량 등재 | 예산과 무관하게 타인 이메일·커밋 제목·경로가 LLM 컨텍스트로 나간다. 되돌릴 수 없는 유출. |
| 5 | A-2 `--since/--until` 축 불일치 | 기간 지정 실행에서 원장이 "누락 0건"을 거짓 단언한다. 산출물의 존재 이유(커버리지 고지)가 무너진다. |

---

# A. context-independent — 설계 맥락과 무관하게 결함 (38건)

## A-1. `git diff --name-status`의 `T`(typechange) 코드에서 파서가 예외를 던져 수집기·검증기가 통째로 죽고 3분류 계약이 우회된다 — Critical

- **위치**: `scripts/lib/git.mjs:414-442` (`parseNameStatusTokens`, 특히 434-439 throw), `scripts/lib/git.mjs:465-475` (`getCommitFileChanges`), `scripts/collect-git-facts.mjs:169-175`, `scripts/verify-evidence.mjs:189·340`, `schemas/evidence.schema.json:266` (`changeType` enum)
- **실패 시나리오**: 과거에 일반 파일을 심볼릭 링크로 바꿨거나 디렉터리를 서브모듈로 전환한 레포(모노레포·인프라 레포에서 흔함)에서 `node scripts/collect-git-facts.mjs --repo . --identity me@corp.com` 실행 → 3,000커밋을 다 읽고도 `evidence.json`이 한 글자도 쓰이지 않고 exit 1. `enriched`가 순회한 **모든** 커밋(봇·타 저자 포함)에 diff를 계산하므로 남이 만든 전환 커밋 1건이 내 경력 수집을 막는다. 검증기 쪽은 더 나쁘다 — 그 경로를 인용한 `career.json`으로 `verify-evidence.mjs`를 돌리면 미처리 예외 스택 트레이스(git.mjs:435 → getCommitFileChanges:475 → verifyCitation:189 → verifyArtifactInstance:272 → verifyEvidence:445 → main:640)로 죽어 리포트 0줄, `--out` 파일 미기록. 종료 코드만 보는 상위 스킬/CI는 이 exit 1을 "인용 검증 FAIL(할루시네이션 탐지)"로 오분류한다. git.mjs가 공들여 만든 (exit code, stderr) 3분류(ok/lookup-failed/tool-error)와 `toolErrors` 리포트 섹션이 이 경로에서는 전혀 작동하지 않는다.
- **수정안**: ① `parseNameStatusTokens`에 `T`를 명시 처리한다 — `changeType` enum을 `T`까지 확장하거나(`schemas/evidence.schema.json:266` 동반 수정), `T/U/X`를 `M`으로 정규화하고 원본 코드를 별도 필드(`rawChangeType`)·플래그(`typeChange: true`)로 남긴다. ② 알 수 없는 코드에 즉시 throw 대신 해당 항목만 스킵하고 경고를 수집해 리포트에 남기는 경로를 둔다. ③ `getCommitFileChanges`가 파서 예외를 삼켜 `{ok:false, outcome:"tool-error", stderr:...}`로 변환해 기존 3분류 계약에 태우고, `collect-git-facts`는 해당 커밋만 건너뛰고 리포트에 남긴다(레포 전체 중단 금지). ④ `verify-evidence.mjs:189`·`:340`의 `getCommitFileChanges` 호출을 try/catch로 감싸 `TOOL_ERROR`(또는 새 `PARSE_ERROR`) 판정으로 강등하고, `main:640`에도 최상위 catch를 둔다. ⑤ 오류 메시지에서 존재하지 않는 `-z` 누락 추정을 첫 원인으로 제시하는 순서를 바꿔 실제 관측값(코드 문자, sha, base)을 먼저 제시한다.
- **묶은 하위 지적**: 정확성 렌즈와 견고성 렌즈가 같은 결함을 독립 발견했다(중복 2건 병합). 견고성 렌즈가 추가로 확인한 두 가지 — verify-evidence의 try/catch 부재로 TOOL_ERROR 강등이 불가능한 점, 종료 코드만 보는 호출자가 정상 FAIL과 구별 못 하는 점 — 을 ④에 포함했다. 단, "오류 메시지가 원인을 완전히 오도한다"는 서술은 과장이다(메시지에 '지원하지 않는 name-status 코드'가 두 번째 대안으로 함께 적혀 있고 `status="T"` 관측값도 노출된다) — 순서 문제로만 다뤄라.

## A-2. `--since/--until`은 committer date로 필터되고 순회를 조기 중단하는데, 원장은 authorDate 기준 기간을 선언하며 `dropped_commits: 0`이라고 단언한다 — Critical

- **위치**: `scripts/lib/git.mjs:246-248` (`listCommitMetadata` — `--since=`/`--until=`을 git에 그대로 전달, `--since-as-filter`·`-n` 미사용), `scripts/collect-git-facts.mjs:150/157`, `scripts/collect-git-facts.mjs:208-212`(truncated)·`250-262`(coverage.period), `schemas/evidence.schema.json:198`
- **실패 시나리오**: 리베이스 기반 워크플로 팀 레포에서 `--since 2024-01-01 --until 2024-12-31`로 "2024년 실적"을 수집한다. (a) 2024년에 작성했지만 committerDate가 2023년인 커밋이 통째로 빠지고, (b) 2019년에 쓴 코드가 2024년 리베이스로 committerDate만 갱신돼 2024년 실적으로 들어오고(양방향 오분류 실측), (c) `git log --since`는 커밋 날짜가 단조롭지 않으면 순회를 조기 중단하므로 c1(2025-01)→c2(2019-01)→c3(2019-01)→c4(2025-02) 레포에서 **기간 안의 c1이 조용히 사라진다**(`--since-as-filter`는 c1+c4를 낸다 — git 2.47 실측). 그런데 원장은 `traversed=1 total=1 truncated={"reason":"none","dropped_commits":0}`으로 **아무것도 누락되지 않았다고 단언한다**. 이 원장으로 만든 경력 기술서는 기간과 내용이 둘 다 틀리고 검증기에는 이 오류를 잡는 축이 없다.
- **수정안**: ① 기간 필터를 git에 그대로 넘기지 말고 전량 순회 후 JS 쪽에서 `authorEpochSec`로 필터한다 — committer/author 축 불일치와 조기 중단을 한 번에 없앤다(차선: `--since-as-filter=` 사용). ② 기간 필터로 떨어진 건수를 `truncated`(예: `reason:"period_filter"`) 또는 coverage의 별도 필드에 기록해 `dropped_commits: 0` 거짓 단언을 없앤다. ③ 근거 보강: `schemas/evidence.schema.json:198`이 스스로 "committerDate는 리베이스로 값이 바뀌므로 쓰지 않는다"고 선언하므로, 기간 필터만 그 원칙을 위반하는 것은 코드베이스 내부 자기모순이다 — 정본 축은 authorDate로 통일하라.

## A-3. shallow clone의 경계 커밋을 루트 커밋으로 오인해 빈 트리와 diff한다 — 코드베이스 전체가 그 커밋 1건의 신규 작성분으로 집계된다(실측 4.2배) — Critical

- **위치**: `scripts/lib/git.mjs:222-224` (`getDiffBase` — `parents.length > 0 ? parents[0] : EMPTY_TREE_SHA`), `scripts/lib/git.mjs:52-56`(주석이 EMPTY_TREE_SHA를 "루트 커밋"으로만 설명), `scripts/collect-git-facts.mjs:140-162`(shallow 여부 미검사)
- **실패 시나리오**: 사용자가 회사 모노레포를 시간 절약을 위해 `git clone --depth 1`로 받아 로컬 경로를 지정한다. shallow 경계 커밋은 `%P`에서 부모가 빈 문자열로 나오므로(grafted) 빈 트리와 diff되어 `evidence.json`에 "이 커밋에서 +200,000줄 / 3,000개 파일을 신규 작성(A)"이 기록된다. 실측: 이 레포를 `--depth 2`로 클론 → 경계 커밋이 `+9315 -0 files:60 changeTypes:["A"]`(실제는 `+2232 -0 files:28`) = 삽입 4.2배·파일 2.1배 부풀림, 경고 0줄. `--depth 1`에서는 추적 파일 64개·1만 라인 전체가 단일 커밋의 신규 작성분이 된다. `git-facts.json`의 `topChangedFiles`·`pathModuleMap`·`extensionHistogram`도 전부 오염되고 churn 버킷이 이 커밋을 최상위로 올린다. 이 값은 원장에 실제로 그렇게 적혀 있으므로 verify-evidence의 (a)(b)(c)축을 모두 통과한다 — **이 제품이 막으려는 "근거 없는 정량 과장"을 도구 자신이 만들어 스스로 승인한다.**
- **수정안**: ① `collectGitFacts` 진입 시 `git rev-parse --is-shallow-repository`(또는 `.git/shallow` 존재)를 확인한다. shallow면 기본적으로 exit 1로 거부하고 `git fetch --unshallow` 안내를 출력한다. ② 계속 진행을 허용한다면 `.git/shallow`의 경계 커밋 해시 집합을 읽어 그 커밋들을 `excluded:true, exclusionReason:"shallow-boundary"`로 제외하고 `coverage`에 shallow 사실을 명시 기록한다. ③ 최소 방어선으로 `getDiffBase`가 EMPTY_TREE_SHA를 반환할 때 `rev-list --max-parents=0`으로 진짜 루트인지 교차 확인하는 가드를 둔다. (참고: `grep -rn "shallow|is-shallow|max-parents|grafted"` 결과 레포 전체 0건.)

## A-4. `--max-commits` 예산이 실제 작업량을 전혀 제한하지 않는다 — 커밋당 git 프로세스 2회를 무조건 스폰하고 상한도 진행 표시도 없다 — Major

- **위치**: `scripts/collect-git-facts.mjs:169-197` (`enriched` map — 샘플링 **이전에** 전량 diff), `scripts/collect-git-facts.mjs:208-226`(maxCommits 판정은 그 이후), `scripts/lib/git.mjs:246-249`(`log`에 `-n` 없음), `scripts/lib/git.mjs:462-475`(호출당 spawnSync 2회)
- **실패 시나리오**: 5년치 업무 레포(3만 커밋, 본인 4천)를 `--max-commits 300`으로 수집한다. 300건만 필요한데 3만 건 전부에 6만 번 git을 띄우므로 실측 단가(135~470 ms/커밋, 환경별)로 45~90분간 stdout/stderr에 **한 줄도 출력되지 않는다**(`collectGitFacts` 본문의 console 호출 0건). 사용자는 hang으로 판단해 Ctrl-C를 누르고 산출물은 0건이며, 대상 디렉터리에 `.evidence.json.tmp-*` 잔여물이 남을 수 있다. 실측 대조: 200커밋 픽스처에서 `--max-commits 1` 57.9초 / `--max-commits 1000` 27.1초 — 예산을 200분의 1로 줄여도 비용이 줄지 않는다.
- **수정안**: ① 샘플링을 diff 수집 **앞**으로 옮긴다. `listCommitMetadata`만으로 population을 만들고, churn 랭킹용 값은 `git log --numstat -z --format=...` **1회 배치 호출**로 커밋 레벨 합계를 얻어 채운 뒤(머지 커밋은 별도 처리), 선택된 K건 + 제외 커밋에 대해서만 커밋별 2-트리 diff를 호출한다 → 스폰 수 O(N) → O(merges + K). ② 메타데이터만으로 exclusion을 먼저 판정해 `excluded===true` 커밋의 diff 계산을 건너뛴다(원장에 files[] 없이 등재하고 그 사실을 명시). ③ 그것이 어렵다면 최소한 `git log`에 `-n <상한>`을 붙여 순회를 유계로 만들고 커밋 50건마다 `[collect-git-facts] 진행 x/N`을 stderr에 출력한다. ④ 순회 커밋 수가 임계치(예: 5,000)를 넘으면 예상 소요 시간을 경고하고 `--since`/`--max-commits` 조정을 안내한다.
- **묶은 하위 지적**: 정확성 렌즈·견고성 렌즈의 중복 2건 병합. 다만 "README가 안내하는 기본 명령"이라는 서술은 사실과 다르다 — README에 `collect-git-facts.mjs` 사용법 언급이 0건이고 `--max-commits 1000` 기본값은 스크립트 헤더 주석에만 있다.

## A-5. `--since`/`--until` 값을 검증하지 않아 git 상대 날짜가 `Date.parse` NaN을 통해 시간 균등(even) 버킷을 조용히 "가장 오래된 커밋 뽑기"로 퇴화시킨다 — Major

- **위치**: `scripts/collect-git-facts.mjs:214-215` (`Date.parse` 검증 없음), `:221`(그 값을 computeSampling에 전달), `:253`(원문을 coverage.period에 기록), `scripts/lib/sampling.mjs:148-149` (`range.since ?? Math.min(...)` — NaN은 nullish가 아니다), `scripts/lib/sampling.mjs:58-104` (`selectEvenBucket`)
- **실패 시나리오**: `--since "2 years ago" --max-commits 200`(git이 정상 지원하는 표기)으로 실행한다. `Date.parse("2 years ago")`=NaN → `minEpoch=NaN` → `span/intervalSize/lo/hi` 전부 NaN → 모든 구간 후보 0건 → carry가 evenCount까지 누적 → 마지막 backfill이 `authorDate asc`로 채운다. 즉 "시간 균등 20%"가 "최고령 커밋 N건"이 되는데, `coverage.samplingMethod`는 정본 리터럴 `even:[since,until] equal-split`을 그대로 선언한다. 실측: 2006~2025 20커밋 레포에서 `--since` 없음 → even 선택 2006·2016 / `--since 2000-01-01` → 2006·2013 / `--since "20 years ago"` → **2007·2008(연속 최고령 2건, 퇴화)**. 300커밋·`--max-commits 50`에서는 선택 집합 차집합 9건. 경고·예외 0건, exit 0. 부수 결함 3건: (i) 유효한 절대 날짜에서도 `Date.parse("2024-01-01")`은 UTC 자정, git은 로컬 TZ로 해석해 경계가 최대 ±14시간 어긋난다. (ii) `--since 2030-01-01`처럼 결과가 0건이면 `[안내] 이 레포에는 커밋이 없습니다(빈 레포 또는 unborn branch)`라는 거짓 안내 + exit 0이 나오는데 같은 산출물의 `sourceRepoHead`는 실제 해시다(자기모순). (iii) `--since --max-commits 2`처럼 다음 플래그를 값으로 삼키면 git이 "now"로 해석해 같은 거짓 안내가 난다.
- **수정안**: ① `since`/`until`을 `YYYY-MM-DD`(또는 ISO 8601) 정규식으로 검증하고 불합격이면 exit 2로 즉시 거부한다. git 상대 날짜를 계속 지원하려면 git에게 정규화를 위임해(`git log --since=<입력> --format=%at` 1회) 실제 컷오프 epoch를 얻고 그 정규화된 값을 `coverage.period`에 기록한다. ② `sampling.mjs:148-149`를 `Number.isFinite(range.since) ? range.since : ...`로 바꿔 NaN이 range로 쓰이지 않게 하고, `computeSampling` 진입부에서 NaN range를 즉시 던져 조용한 퇴화를 막는다. ③ 빈 레포 안내 조건을 `traversed===0`만이 아니라 `hasAnyCommitOnHead()===false`와 결합해 "지정 기간에 해당하는 커밋이 없습니다"로 구분 출력한다.
- **묶은 하위 지적**: 정확성 렌즈(NaN 퇴화)·견고성 렌즈(입력 검증 부재 + 거짓 빈 레포 안내) 2건 병합. 참고로 `evidence.schema.json:82-96`의 `format:"date"` 제약이 `--schema-check`에서는 이 산출물을 FAIL시키지만, 수집기가 그 검사를 자동 호출하지 않아 방어가 되지 않는다.

## A-6. churn 버킷(표본의 40%)이 vendored/lockfile 커밋으로 채워지고, 기본 패턴 `/\.lock$/`가 `package-lock.json`을 놓쳐 그 파일이 `topChangedFiles` 1위가 된다 — Major

- **위치**: `scripts/lib/sampling.mjs:126-131`(churn 버킷), `scripts/collect-git-facts.mjs:193`(`churn = insertions + deletions`, vendored 미고려), `scripts/collect-git-facts.mjs:60-66`(`DEFAULT_VENDORED_PATH_PATTERNS`), `scripts/collect-git-facts.mjs:77-80`(`isVendoredPath`), `:331`(vendored 필터는 집계에서만)
- **실패 시나리오**: npm 프로젝트를 `--max-commits 500`으로 수집하면 (a) churn 버킷 200건 중 상당수가 lockfile만 5,000줄 갈아치운 `chore(deps): bump ...` 커밋으로 채워져 실제 기능 커밋이 표본에서 밀려나고, (b) `topChangedFiles[0]`이 `package-lock.json`(churn 수만)이 되며 `extensionHistogram`이 `.json`으로, `pathModuleMap`이 `(root)`로 왜곡된다. 실측(feat 12건 + `chore: update deps` 4건, `--max-commits 10`): churn 상위 4건이 chore 4건 전부, feat 모듈 02~08이 탈락, `topChangedFiles[0]={"path":"package-lock.json","churn":35000}`. 패턴 실측: `package-lock.json`=false, `pnpm-lock.yaml`=false, `go.sum`=false, `yarn.lock`=true, `Cargo.lock`=true.
- **수정안**: ① churn 랭킹용 값을 `files[]`에서 vendored 경로를 뺀 합으로 계산한다(집계와 같은 `isVendoredPath` 재사용). 값 정의가 바뀌므로 `samplingMethod` 리터럴·골든·`PROVENANCE.md`를 함께 갱신해야 한다. ② `DEFAULT_VENDORED_PATH_PATTERNS`에 `/(^|\/)package-lock\.json$/`, `/(^|\/)pnpm-lock\.yaml$/`, `/(^|\/)go\.sum$/`, `/(^|\/)composer\.lock$/`, `/(^|\/)poetry\.lock$/`를 추가한다.

## A-7. `contentHash`·`sourceRepoHead`를 5개 스키마가 "정본 무결성 장치"로 선언하는데 재계산·대조 코드가 레포 전체에 0곳이다 — Major

- **위치**: `scripts/collect-git-facts.mjs:248,272-285`(계산·기록), `schemas/evidence.schema.json:26-33`, `schemas/career.schema.json:15-21`, `schemas/knowledge-map.schema.json:15-20`, `schemas/gap-report.schema.json:15-20`, `schemas/plan.schema.json:15-20`, `scripts/verify-evidence.mjs`(두 필드 미참조), `scripts/validate-plugin.mjs`·`scripts/lib/invariants.mjs`(미참조)
- **실패 시나리오**: 사용자(또는 상위 LLM)가 `evidence.json`에서 동료 커밋 1건의 `authorEmail`을 자기 이메일로, `excluded`를 false로 고치고 `coverage` 수치만 맞춘다(AC-6 교차 불변식은 통과한다). 그 커밋을 `basis:"commit"`으로 인용한 `career.json`에 대해 `validate-plugin.mjs --schema-check` → `[PASS]` exit 0, `verify-evidence.mjs` → `total=1 pass=1 fail=0` `[PASS]` exit 0(실측). `contentHash`는 이미 본문과 어긋나 있는데 아무도 읽지 않으므로 **변조 흔적조차 남지 않는다.** 히스토리를 rewrite한 뒤 옛 원장으로 검증해도 스테일 경고가 없다. 부수 사실: 스키마 제약이 `minLength: 1`뿐이어서 `tests/fixtures-invalid/13~17`이 `"contentHash": "deadbeefcafe"`(13자)로 게이트를 통과한다.
- **수정안**: ① `collect-git-facts.mjs:272`의 해시 산식을 `scripts/lib/`의 함수 하나(`computeArtifactContentHash(obj)`)로 빼내 쓰기 지점과 검증 지점이 같은 구현·같은 키 순서를 공유하게 한다(현재는 `evidenceWithoutHash`와 최종 evidence가 서로 다른 객체 조립이라 키 순서 규칙이 코드에 명시돼 있지 않다). ② 해시 대상에서 `generatedAt`을 제외해 "같은 레포·같은 옵션 → 같은 해시"가 성립하게 만든다(결정성 게이트에도 쓸 수 있다). ③ `verify-evidence.mjs`와 `--schema-check`의 evidence 경로에서 재계산·대조해 불일치는 전용 코드(`EVIDENCE_CONTENT_HASH_MISMATCH`)로 FAIL시키고 `ok` 판정에 포함한다. ④ `sourceRepoHead`를 `--repo`의 현재 HEAD와 비교해 스테일 경고를 낸다. ⑤ 키 없는 SHA-256으로는 의도적 위조를 막을 수 없다는 한계를 스키마 description과 README에 명시하고 "사용자 수동 편집 감지"라는 현재형 단정을 "우발적 손상·부분 편집 감지"로 정확히 바꾼다 — 의도적 위조 방어는 A-8의 (a)축 재도출로 해결해야 한다. ⑥ `tests/fixtures-invalid/`에 "contentHash만 어긋난 evidence.json" 케이스를 추가한다.
- **묶은 하위 지적**: 4개 렌즈가 독립 발견한 4건 병합(정확성/구조/계약/보안). **트리아지 주의**: 이 중 2건은 소비자(AC-16 덮어쓰기 게이트·AC-22 스테일 경고)가 미구현 skills 계층의 몫일 가능성을 들어 `may-be-intentional`로 분류했다 — 설계 문서와 대조하라. 다만 "스키마 description이 현재형으로 존재한다고 단정한다"와 "위조 원장이 두 게이트를 통과한다"는 관측은 현재 코드의 사실이다.

## A-8. 인용 검증 (a)축이 원장의 `authorEmail`·`excluded`를 그대로 신뢰해, 동료 커밋을 3필드 편집으로 「스크립트 검증된 본인 실적」으로 통과시킨다 — Major

- **위치**: `scripts/verify-evidence.mjs:157-170` ((a)축 — `findLedgerEntry`가 반환한 `ledgerEntry.excluded`·`ledgerEntry.authorEmail`만 조회), `:165`(주석이 "원장 excluded 플래그와 무관한 독립 검사 — 스테일 원장 방어"라고 선언)
- **실패 시나리오**: `~/.devcareer/<repo-key>/evidence.json`에서 동료 커밋의 `excluded:true→false`, `exclusionReason:null`, `authorEmail→me@corp.com` 3필드만 고치고 그 해시를 `basis:"commit"`으로 인용하면 `pass=1 fail=0` `[PASS]` exit 0이 나온다(실측). 커밋이 레포에 실재하고 경로도 diff에 있으므로 (b)(c)축은 정직하게 PASS하며 거짓은 (a)축이 신뢰한 원장 한 곳에만 있다. 역방향도 성립한다 — 원장이 스테일해 `authorEmail`이 낡은 값이면 진짜 본인 커밋이 근거 없이 FAIL한다. README가 "타 저자 커밋 인용 … 100% 탐지를 목표로 한다"고 고지하는 축이 바로 이것이다. 부분 방어(`--schema-check`의 `checkCoverageTraversedInvariant`)는 `coverage.total`·`analyzed`를 함께 고치는 5필드 변조로 우회된다(실측: 양쪽 모두 `[PASS]`).
- **수정안**: ① (a)축의 저자 판정 오라클을 원장에서 git으로 옮긴다 — (b)축의 `rev-parse`를 `git show -s --format=%ae%n%P <sha>` 1회로 대체해 실존성·저자·부모를 한 번에 얻고(스폰 수는 오히려 줄어든다) `selectedIdentities`와 대조, 원장 값과 다르면 `CITATION_LEDGER_AUTHOR_MISMATCH`로 FAIL한다. ② `excluded`도 원장 플래그와 별개로 「봇 패턴 · 선택 identity · 머지 여부」를 검증 시점에 재판정해 교차 비교한다 — 그래야 `:165` 주석이 주장하는 독립성이 실제로 성립한다. ③ A-15의 캐시 개선과 함께 적용하면 비용 증가 없이 가능하다.
- **묶은 하위 지적**: 보안 렌즈(Major)·견고성 렌즈(Major) 2건 병합. 견고성 렌즈는 `contentHash` 미검증(A-7)과 묶어 제기했으므로 두 수정이 함께 배포돼야 원장 변조 경로가 닫힌다.

## A-9. `redact.mjs`가 어디서도 import되지 않는 죽은 코드인데 README·config 스키마는 마스킹이 적용된다고 약속하고, 커밋 제목·co-author의 시크릿·이메일이 원문 그대로 원장에 기록된다 — Major

- **위치**: `scripts/lib/redact.mjs`(레포 전체 import 0건 — scripts/·tests/·fixtures/ grep 확인), `scripts/collect-git-facts.mjs:230-246`(`subject`·`coAuthors` 무가공 직렬화), `README.md`의 마스킹 한계 고지, `schemas/config.schema.json:152`(`snippetQuoting` description — "true여도 diff 인용 경로에 시크릿/PII 마스킹은 항상 적용된다"고 무조건문으로 단정)
- **실패 시나리오**: 사내 레포에서 수집기를 실행하면 `"subject": "fix: rotate leaked key AKIAIOSFODNN7EXAMPLE in prod config"`, `"subject": "chore: temp workaround password=Sup3rSecret! for db"`, `"subject": "feat: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123XYZ token added"`, `"coAuthors": ["Co-authored-by: Carol Park <carol.park@corp.example>"]`가 전부 원문으로 `evidence.json`에 들어간다(실측). 커밋 제목은 diff 원문이 아니므로 `--no-diff` 기본값의 보호 범위 밖이다. 사용자는 README의 마스킹 고지를 근거로 "알려진 시크릿은 걸러진다"고 믿어 제목을 사전 점검하지 않고, 아직 회수되지 않은 크리덴셜이 제3자 API 로그와 로컬 파일에 평문으로 남는다.
- **수정안**: 둘 중 하나를 택하되 문서와 코드를 일치시켜라. ① 수집기의 `subject`·`coAuthors` 직렬화 지점에 `redactSecrets`를 실제 배선하고 마스킹 히트 수를 stderr/원장 헤더에 보고한다 — **단 A-10의 40자 hex 오탐을 먼저 고쳐야 커밋 해시가 파괴되지 않는다**(subject에 short/full hash가 자주 등장한다). ② 배선하지 않기로 결정했다면 README와 `config.schema.json:152`의 마스킹 문장을 "현 단계에서는 마스킹이 적용되지 않는다. 커밋 제목·co-author 트레일러는 원문 그대로 기록되므로 실행 전에 점검하라"로 바꾼다. 어느 쪽이든 호출자 없는 상태(= 마스킹 회귀를 잡을 오라클이 0개인 상태)를 없애고, 배선 시 tests에 마스킹 케이스를 추가한다(`fixtures/make-fixture.mjs`의 `buildSecrets`가 이미 있으나 배선돼 있지 않다 — A-14 참조).
- **묶은 하위 지적**: 보안 렌즈 2건 + 계약 렌즈 1건 병합. `redact.mjs` 헤더 주석이 "P0 기본값(--no-diff)에서는 호출되지 않지만 구현 7단계 이후 공유할 단일 구현으로 둔다"고 밝히므로 미배선 자체는 단계적 배치일 개연성이 있다 — 그러나 배포된 스키마가 무조건문으로 약속한다는 사실은 그 변론으로 해소되지 않는다.

## A-10. `redact.mjs`의 패턴이 흔한 변형을 통과시키면서 40자 hex 커밋 해시는 시크릿으로 오탐해 파괴한다 — Major

- **위치**: `scripts/lib/redact.mjs:14-21`(PATTERNS 전체), 특히 `:16` aws-secret-key `/\b(?:[A-Za-z0-9+\/]{40})\b/g`, `:17` private-key-block, `:18` jwt, `:19` password-field, `:20` email
- **실패 시나리오**: (a) 옵트인 스니펫 경로가 이 모듈을 배선하면 다음이 **마스킹 0건**으로 LLM에 전송된다(16개 입력 실측): `DB_PASSWORD=hunter2horse`, `db_password=...`(선행 `_`가 단어 문자라 `\b`가 성립하지 않는다 — 환경변수 표기 전부 누출), `password: hunter2horse`, `"password": "..."`(패턴이 `=`만 인정), `MYSQL_PWD=...`, END 마커 없는 잘린 PEM 블록(diff 훅은 파일 일부만 담으므로 키 본문이 그대로 남는다), 소문자 PEM 헤더, payload가 `eyA`로 시작하는 JWT, 서명이 빈 `alg:none` JWT. `containsSecretPattern`도 false를 반환해 "마스킹 히트 0건"이 정상처럼 보인다. (b) 반대로 `redactSecrets("commit f69b245fb72735915423b9068e629868b7dd7a99 in scripts/lib/git.mjs")` → `"commit [REDACTED:aws-secret-key] in ..."`, `"commit:f69b…"` → `"commit:[REDACTED:aws-secret-key]"`. `evidence.schema.json:56-59`가 `commitHash`를 `^[0-9a-f]{40}$`로 정의하므로 **이 도구의 유일한 인용 앵커가 전부 오탐 대상**이고, `email` 패턴은 required 필드인 `authorEmail`까지 통째로 마스킹한다. 배선 시 `ledgerId`가 `commit:[REDACTED:...]`가 되어 `CITATION_MALFORMED_LEDGER_ID`로 전건 FAIL하거나 사용자에게 보이는 근거 해시가 사라진다.
- **수정안**: ① `aws-secret-key`에서 40자 순수 hex를 반드시 제외한다(`(?![0-9a-f]{40}\b)` 선행 부정 또는 대문자·기호 최소 1자 요구) — 이 예외 없이는 마스킹을 인용 경로에 배선할 수 없다. 정탐 케이스(`fixtures/make-fixture.mjs:574`의 `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`)는 `/`·대문자를 포함하므로 그대로 잡힌다. ② `password-field`는 좌측 경계를 `(?<![A-Za-z0-9])`로, 구분자를 `[:=]`로, 키 이름을 `[A-Za-z0-9_]*(password|passwd|pwd|secret|token)`로 넓힌다. ③ `private-key-block`은 END 마커를 옵셔널로(`-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*-----|$)`) 하고 대소문자 무시 플래그를 붙인다. ④ `jwt`는 두 번째 세그먼트를 `ey[A-Za-z0-9_-]+`, 서명을 `[A-Za-z0-9_-]*`로 완화한다. ⑤ 각 케이스를 tests에 정탐/오탐 픽스처로 고정한다 — 특히 "40자 커밋 SHA·shortHash·경로는 마스킹되지 않는다" 단언 1건은 배선 전이라도 넣어라.
- **묶은 하위 지적**: 보안 렌즈 2건 + 구조 렌즈 1건 병합(모두 40자 hex 충돌을 독립 관측).

## A-11. `--ref all`이 `refs/stash`를 진짜 커밋으로 원장에 넣는다 — untracked 파일 경로까지 evidence.json에 실린다 — Major

- **위치**: `scripts/lib/git.mjs:246` (`["log", ref === "--all" ? "--all" : "HEAD"]` — 제외 ref 지정 없음), `scripts/collect-git-facts.mjs:88-99`(`classifyExclusion`의 제외 축은 봇/저자미선택/머지 3개뿐), `:156-162`
- **실패 시나리오**: 미머지 피처 브랜치를 놓치지 않으려고 `--ref all`을 켠다. stash 엔트리 1개당 커밋 3건(`On <branch>: ...` 2~3부모 머지 / `index on <branch>: ...` / `untracked files on <branch>: ...` **부모 없는 루트 커밋**)이 유입된다. 실측(커밋 1개 + `git stash push -u` 1회): `traversed=4 total=4 analyzed=4`, 4건 전부 `excluded:false`. `--merge-included` 없이도 `index on`·`untracked files on` 2건은 머지가 아니어서 제외 축에 걸리지 않고 analyzed에 남는다. 그리고 `untracked files on main` 커밋의 `files[]`는 `A: .env.local` — 사용자가 의도적으로 커밋하지 않은 경로(개인 스크래치, 시크릿 파일)가 원장에 기록되고 `topChangedFiles`·`conventionalCommitTypeDistribution(other)`까지 오염된다. stash 3개면 유령 커밋 9건이 커버리지 수치를 부풀린다.
- **수정안**: ① `--all` 대신 `--branches --tags --remotes`를 쓰거나 `--all --exclude=refs/stash --exclude=refs/notes/*`를 붙인다(`refs/replace`·`refs/bisect`도 함께 제외). ② 방어층으로 stash 엔트리 형태(부모 2~3개 + subject가 `^(On|index on|untracked files on) `로 시작)를 `exclusionReason: "stash-entry"`로 명시 제외한다.
- **주의**: 원 지적의 두 표현은 과장이다 — README에 `--ref` 언급이 0건이고(안내는 스크립트 헤더 주석·printUsage뿐), README의 PII 고지는 파일 경로 마스킹을 약속하지 않는다.

## A-12. 고정 git 프리픽스가 `diff.renames`를 고정하지 않아 같은 레포가 사용자 gitconfig에 따라 완전히 다른 원장을 낸다 — Major

- **위치**: `scripts/lib/git.mjs:46-50` (`GIT_FIXED_PREFIX_ARGS` — `--no-pager`·`core.quotepath=false`·`i18n.logOutputEncoding=UTF-8` 3개만 고정), `scripts/lib/git.mjs:466-470`(그 프리픽스로 diff 호출), `fixtures/make-fixture.mjs:96-97`(픽스처는 `commit.gpgsign`·`core.autocrlf`만 고정)
- **실패 시나리오**: 개발자 A(기본 설정)와 개발자 B(`diff.renames=false`가 든 회사 표준 gitconfig)가 같은 레포에 같은 인자로 수집기를 돌린다. 실측(리네임+수정+추가 혼합 커밋): 기본 → `files 3건, R src/renamed.ts old=src/old.ts, 3/0, contentHash e7ffc01a81ba8119` / `diff.renames=false` → `files 4건(D src/old.ts 0/8 + A src/renamed.ts 9/0, oldPath 전부 null), 11/8, contentHash 550636763e74f188`. `files[]` 건수·changeType·oldPath·커밋 레벨 insertions/deletions가 갈리므로 churn 랭킹과 샘플링 선택 집합, `topChangedFiles`, `contentHash`까지 전부 달라진다 — "결정적 수집기"라는 전제가 읽는 사람의 gitconfig에 종속되고, 골든은 이 축의 드리프트를 잡지 못해 두 사람 모두 자기 기준으로는 테스트 통과 상태다.
- **수정안**: `GIT_FIXED_PREFIX_ARGS`에 `-c diff.renames=true -c diff.renameLimit=0`(무제한)을 추가한다. 결정성을 위해 `-c core.autocrlf=false -c diff.algorithm=myers -c log.showSignature=false`도 함께 고정하는 것이 안전하다. **정정**: 원 지적이 함께 제안한 `log.mailmap` 고정은 불필요하다 — `LOG_FORMAT`(git.mjs:178)이 쓰는 것은 `%ae`(raw)이고 mailmap을 타는 것은 `%aE`이므로 identity 매칭에 영향하지 않는다. `diff.renameLimit` 축(기본 1000 초과 대형 커밋에서 커밋별로 리네임 탐지가 켜졌다 꺼졌다 하는 문제)은 미실측이다.

## A-13. 수집기가 만든 `evidence.json`을 `evidence.schema.json`으로 검증하는 테스트가 한 건도 없다 — 구조 위반 산출물이 4개 게이트를 전부 통과한다 — Major

- **위치**: `tests/run-smoke.mjs:1706-1745`(main — 어떤 섹션도 수집기 산출물에 `runSchemaCheck`를 적용하지 않음), `tests/run-smoke.mjs:1633-1656`(`runSchemaCheck`는 `tests/fixtures-invalid/`의 정적 JSON에만 호출), `scripts/validate-plugin.mjs:669-745`(게이트 자체는 정상 동작)
- **실패 시나리오**: 누군가 `evidence.json`에 필드를 추가·개명하거나(예: `shortHash` → `abbrev`) 스키마만 갱신하고 수집기를 고치지 않는다. 실측: 사본에서 수집기 조립부에 스키마 밖 최상위 필드 `strayFieldMutation5`를 추가하고 required인 `commits[].shortHash` 생성을 삭제한 뒤 → 기본 스모크 71 PASS / `--negative` 88 PASS / `--golden` 11 PASS / `npm run lint` exit 0 — **4개 게이트 전부 녹색**. 같은 산출물을 `--schema-check`에 직접 넣으면 `SCHEMA_CHECK_VIOLATION: $.commits[0]: required 필드 'shortHash' 없음`이 즉시 나온다. 게이트는 있고 동작하는데 아무도 수집기 산출물을 그 게이트에 넣지 않는다. `tests/` 전체에서 `evidence.schema.json`을 로드하는 코드가 0건이다.
- **수정안**: `runVerifyEvidenceSmoke`/`runFastTruncationInvariantSmoke`/`runGoldenGate`에서 `collectGitFacts` 결과를 임시 파일로 쓰고 `runSchemaCheck({instancePath})`를 호출해 `ok===true`를 단언하는 절을 추가한다(디스크 쓰기를 피하려면 `validateInstance`를 직접 호출해도 동일 효과). 최소한 골든 게이트에서 300커밋 산출물 1건은 반드시 구조 검증을 통과해야 한다. 참고로 AC-6 교차 불변식(`checkEvidenceInvariants`)은 이미 수집기 산출물에 적용되고 있으므로, 미검증 영역은 정확히 "구조 검증(required/type/additionalProperties)"이다.

## A-14. coAuthors 추출·binary 판정·git-facts.json 집계 전체·vendored 제외 — 프로덕션 동작 4종에 단언이 0건이고 그 용도의 픽스처 11개가 배선되지 않은 채 방치돼 있다 — Major

- **위치**: `scripts/lib/git.mjs:192-201`(`parseCoAuthorTrailers`), `scripts/lib/git.mjs:377-382`(binary 판정), `scripts/collect-git-facts.mjs:309-360`(`buildGitFacts`), `:77-80`(`isVendoredPath`), `fixtures/make-fixture.mjs:504·538·570·603`(`buildCoAuthorTrailer`/`buildVendoredPaths`/`buildSecrets`/`buildBinaryFile` — tests에서 import 0건)
- **실패 시나리오**: 실측으로 4개 변이(`parseCoAuthorTrailers`가 항상 `[]` 반환 / `binary`를 항상 false / `buildGitFacts`가 `{}` 반환 / `isVendoredPath`가 항상 false)를 동시 적용했더니 71 PASS / 88 PASS / 11 PASS / lint exit 0 — **전부 무탐지**. 즉 `git log %B` 포맷이나 트레일러 파싱을 건드리는 리팩터가 coAuthors를 조용히 빈 배열로 만들어도 `npm test`는 green이고, 사용자 산출물에서 공동 기여 사실이 통째로 사라진다. binary 판정이 깨지면 `git.mjs:381-382`의 `insertions: binary ? null : Number(insRaw)`에서 `Number("-")`=NaN이 원장에 들어가 JSON 직렬화 시 `null`이 되어 정량 근거가 소리 없이 망가진다. `git-facts.json`은 수집기의 두 산출물 중 하나인데 통째로 무검증이다(`gitFacts`·`pathModuleMap`·`extensionHistogram`·`topChangedFiles`·`conventionalCommit`이 tests에 0건). 그런데 `fixtures/README.md`의 시나리오 표는 이 시나리오들에 "오라클 대상 AC"(AC-11 마스킹, AC-6 binary, coAuthors 비공허성, §5 vendored 제외)를 적어 커버리지 행렬처럼 읽힌다.
- **수정안**: 이미 존재하는 픽스처를 배선하는 것으로 충분하다 — ① `buildCoAuthorTrailer` → `collectGitFacts` → `commits[].coAuthors`가 declared 트레일러 원문과 일치. ② `buildBinaryFile` → `files[].binary===true && insertions===0`. ③ `buildVendoredPaths` → git-facts의 `pathModuleMap`/`extensionHistogram`에 vendored 경로가 없음. ④ `buildGitFacts` 산출물의 `topChangedFiles`/`conventionalCommitTypeDistribution` 기대값 단언. ⑤ `buildSecrets`는 A-9/A-10 배선 시 마스킹 오라클로 연결한다. ⑥ 배선 계획이 없는 픽스처는 삭제하고 `fixtures/README.md` 표를 실제 커버리지와 일치시킨다(`buildEmptyRepo`·`buildSingleCommit`·`buildKorean`·`buildSpacePath`·`buildEmptyMessage`·`buildAllFixtures`·`buildCase17MergeHashInjection` 포함 11개 export가 미배선).

## A-15. verify-evidence가 인용마다 git 프로세스를 1~3회 새로 스폰하고 메모이제이션이 전혀 없다 — 동일 커밋·경로 인용 100건에 실측 21~60초 — Major

- **위치**: `scripts/verify-evidence.mjs:139-215`(`verifyCitation` — `revParseVerifyCommit` 1회 + `getCommitFileChanges` 2회), `:266-280`(`verifyArtifactInstance` 이중 루프, 캐시 없음), `:326-380`(`verifyMergeFileSetEquivalence` — 머지 커밋당 추가 2회), `:443-448`(`verifyEvidence` 스코프에도 캐시 없음)
- **실패 시나리오**: L1~L3 산출물(career/knowledge-map/gap-report)을 모두 넘기면 인용 총계가 쉽게 400건을 넘고(스키마의 `nodes`에 maxItems 없음), 여기에 머지 집합 동치 재계산이 더해진다. 실측: 5커밋 tiny 레포에 동일 커밋·동일 경로를 100노드에서 반복 인용 → 300회 스폰 전부 중복, 21.5초(측정 환경에 따라 60.4초, 604 ms/인용). 캐시가 있었다면 3회로 끝난다. LLM이 FAIL을 보고 문장을 고쳐 재검증하는 루프에서는 매 라운드 전액을 다시 지불하므로 3~4회면 검증에만 5~6분이 소모되고 그동안 진행 출력이 없다.
- **수정안**: `verifyEvidence` 스코프에 두 Map(`(repoPath,sha) → revParse 결과`, `(repoPath,sha) → getCommitFileChanges 결과`)을 두고 경로 검사는 캐시된 `files[]`에서 조회한다. 머지 집합 동치도 같은 diff 캐시를 재사용하면 (c)축과 (e)축이 같은 커밋 diff를 두 번 계산하는 낭비도 사라진다. 인용 50건마다 진행 표시를 stderr에 출력한다. A-8의 `git show -s --format=%ae%n%P` 통합과 함께 적용하면 스폰 수가 더 줄어든다.

## A-16. CLI 인자·identity 값을 검증하지 않아 실패가 exit 0 「성공」으로 보고되고 개인 경력 데이터가 의도하지 않은 위치에 기록된다 — Major

- **위치**: `scripts/collect-git-facts.mjs:417-472`(`parseArgs` — 모든 `argv[++i]` 무검증, default 절은 경고 후 계속 진행), `:446`(`Number(argv[++i])`), `:92`(`selectedIdentities.includes(commit.authorEmail)` 정확 문자열 비교), `:484-495`(main 게이트 — repo 누락·identity 개수 0만 검사), `:519-524`(`traversed===0`만 안내), `scripts/verify-evidence.mjs:497-544`(동일 패턴)
- **실패 시나리오**(모두 실측, 전부 exit 0):
  - `--identity Leejg@Aptner.com`(도메인 대소문자만 다름) → `traversed=9 total=0 analyzed=0 reason=none`, `evidence.json` 정상 기록. 소문자로 주면 `total=8`이므로 원인은 대소문자 하나다. 상위 계층은 이 "정상" 원장으로 근거 0건 기술서를 만들고, 사용자는 왜 자기 커밋이 안 잡히는지 단서가 없다.
  - `--out`(값 누락, 마지막 인자) → falsy 폴백으로 `~/.devcareer/<repo-key>/evidence.json`에 기록. 셸 스크립트에서 `--out "$OUT_DIR"`의 변수가 비면 흔히 발생하며, `.gitignore` 주석이 "개인 경력 데이터·실제 커밋 해시·PII"라고 명시한 그 데이터가 사용자가 의도하지 않은(백업·동기화 대상일 수 있는) 위치에 남는다.
  - `--identity`(값 누락) → `[undefined]`/다음 플래그 문자열이 값으로 채택되어 `length===0` 게이트를 통과, `coverage.exclusions.selectedIdentities: [null]`이 기록된 빈 원장 + 성공 메시지.
  - `--max-commits abc` → `[오류] 수집 실패: 샘플링 불변식 위반: 선택 수(0) != K(NaN)` — 실패하지만 메시지가 원인을 전혀 지목하지 않는다(`-3`도 동일).
  - `--max-commit 2`(오타) → 경고 2줄 후 **기본값 1000으로 조용히 진행**, exit 0. 사용자는 자기가 지정한 값이 반영됐다고 믿는다.
- **수정안**: ① 공통 값 검증 헬퍼 — `const v = argv[++i]; if (v === undefined || v.startsWith("--")) { printUsage(); process.exit(2); }`. ② `--max-commits`는 `Number.isInteger(n) && n >= 1` 강제, 위반 시 exit 2. ③ 알 수 없는 인자는 경고가 아니라 exit 2로 거부한다(오타로 기본값이 조용히 쓰이는 경로 차단). ④ `--identity` 값은 최소한 `@` 포함을 확인하고, 이메일 비교를 정규화(도메인 소문자 폴드 또는 전체 소문자)해 그 규칙을 `store.mjs`의 경로 정규화처럼 한 함수에 모은다. ⑤ `traversed > 0 && total === 0`이면 "선택한 identity에 해당하는 커밋이 0건입니다 — `git shortlog -sne` 값과 일치하는지 확인하십시오"를 실제 저자 상위 목록과 함께 출력하고 exit 3 등 별도 코드로 종료해 빈 원장이 성공으로 흐르지 않게 한다. ⑥ 같은 규칙을 `verify-evidence.mjs`의 parseArgs에도 적용한다.
- **묶은 하위 지적**: 구조 렌즈 2건 + 견고성 렌즈 1건 병합. 종료 코드 관련 사실 오기 1건 정정 — `--max-commits abc`의 실제 종료 코드는 1이다(원 지적은 0으로 관측했다고 썼다).

## A-17. `evidence.json`과 `git-facts.json` 사이에 원자성이 없다 — 부분 실패 시 두 파일이 서로 다른 실행 결과를 담고 임시 파일이 영구 잔류한다 — Major

- **위치**: `scripts/collect-git-facts.mjs:366-373`(`writeJsonAtomic` — mkdir → writeFileSync(tmp) → renameSync, try/catch·unlink 없음), `:385-393`(`writeCollectorOutput` — 두 번의 독립 쓰기, 롤백 없음), `scripts/lib/store.mjs:186-194`
- **실패 시나리오**: 백신·파일 인덱서·에디터가 `~/.devcareer/<repo-key>/git-facts.json`을 잠고 있는 순간(Windows에서 흔하다) 재수집하면 `[오류] 쓰기 실패: EPERM ... rename` + exit 1이 난다. 사용자는 "아무것도 안 바뀌었겠지"라고 판단하지만 실측 상태는 `evidence.json`이 **이미 2차 내용(analyzed=2)으로 교체됨** + `git-facts.json`은 1차 내용(5커밋 집계) + `.git-facts.json.tmp-37400-1787016024497` 영구 잔류다. 오류 메시지는 evidence.json이 이미 교체됐다는 사실을 알리지 않는다. 이후 상위 스킬이 두 파일을 함께 읽어 "원장 50건 + 집계 280건 기준" 혼합 기술서를 만들며, `verify-evidence`는 `git-facts.json`을 아예 읽지 않으므로(grep 0건) 어떤 검증기도 이 불일치를 잡지 못한다. 동일 메커니즘이 동시 실행(파일 단위 last-writer-wins, 잠금 없음)에도 적용된다 — 다만 인터리빙 재현은 실패했으므로 이 부분은 코드 추론이다.
- **수정안**: ① 두 파일을 한 트랜잭션으로 쓴다 — 두 temp를 모두 쓰고 둘 다 성공했을 때만 순차 rename, 두 번째 rename 실패 시 첫 번째를 백업본(`.bak`)에서 되돌린다. ② `writeJsonAtomic`을 try/catch로 감싸 실패 시 자기 temp를 `unlinkSync`한다. ③ 시작 시 출력 디렉터리의 `.*.tmp-*` 잔여물을 정리한다(현재 정리 코드가 레포 전체에 0곳). ④ 오류 메시지에 "evidence.json은 이미 갱신되었고 git-facts.json은 이전 실행 값입니다 — 재수집이 필요합니다"를 명시한다. ⑤ 출력 디렉터리에 O_EXCL 락 파일을 두어 동시 실행을 직렬화한다.

## A-18. `--storage repo` 옵트인이 대상 레포에 PII 파일을 쓰면서 `.gitignore` 추가도 경고도 하지 않는다 — 스키마가 스스로 약속한 방어가 미구현 — Major

- **위치**: `scripts/lib/store.mjs:216-227`(`resolveStorageRoot` — repo 모드에서 `repoOptIn`만 확인하고 루트 반환), `scripts/collect-git-facts.mjs:385-392`(`writeCollectorOutput`), `:541-546`(성공 로그는 경로 두 줄뿐), `schemas/config.schema.json:139`(`repoOptIn`: "동의 시 대상 레포 .gitignore에 항목 추가를 제안한다"), README 동일 문구
- **실패 시나리오**: 사용자가 "레포 안에 두는 게 편하다"를 선택한다. 사내 레포 작업 트리에 `.devcareer/evidence.json`(동료 이메일 전량 + 커밋 제목 전량 + 본인 경력 데이터)이 생기고 `.gitignore`는 손대지 않으며 경고 0줄이다. 실측: 생성 직후 `git status --porcelain` → `?? .devcareer/`, `git add -A --dry-run` → `add '.devcareer/evidence.json'`, `git check-ignore -q .devcareer` → exit 1(NOT IGNORED). 며칠 뒤 습관적인 `git add -A && git commit && git push`로 개인 경력 데이터와 동료 PII가 사내 공유 레포 히스토리에 영구 커밋된다 — 지우려면 history rewrite가 필요하고 이미 fetch한 동료에게는 남는다. "그 제안은 스킬이 한다"는 변론은 성립하지 않는다(`skills/`·`commands/` 디렉터리 자체가 없다).
- **수정안**: `resolveStorageRoot`가 repo 모드를 반환하기 전(또는 repo 모드 쓰기 직전) `git check-ignore -q .devcareer`(exit 0/1 — 상위 `.gitignore`·global excludes까지 정확히 반영)로 판정하고, ignore되지 않으면 ① 항목을 추가하거나 ② 최소한 stderr에 차단성 경고를 내고 두 번째 명시 확인 없이는 쓰기를 거부한다. 스키마·README가 이미 이 동작을 약속하므로 문서를 낮추는 대신 코드를 채워라.

## A-19. 정본 `samplingMethod` 리터럴의 드리프트 가드가 어떤 게이트에도 배선돼 있지 않아, 정본(스키마)만 고치면 4개 게이트가 전부 녹색으로 남는다 — Major

- **위치**: `schemas/evidence.schema.json:124-129`(①정본 description), `scripts/lib/sampling.mjs:11-22`(②프로덕션 사본 `CANONICAL_SAMPLING_METHOD_LITERAL`), `fixtures/golden/compute-sampling-golden.mjs:36-65`(③사본 + ①↔③ 가드 `assertNoLiteralDrift`), `fixtures/golden/sampling-300.expected.json`(④스냅샷), `package.json:16`, `tests/run-smoke.mjs:452·1580-1583`
- **실패 시나리오**: 샘플링 비율 정책을 40/40/20 → 50/30/20으로 바꾸며 계약이 적힌 곳(스키마 description)을 먼저 고친다. 실측: `validate-plugin.mjs` exit 0, 스모크 71 PASS, `--negative` 88 PASS, `--golden` 11 PASS — 전부 녹색이라 변경 완료로 판단해 커밋한다. 이후 수집기는 여전히 40/40/20으로 샘플링하면서 원장 헤더에는 sampling.mjs의 40/40/20 리터럴을 기재하므로, 스키마가 선언한 정본 규칙과 산출물 헤더가 다른 문자열을 담고 사용자에게 고지되는 "절단 시 무슨 규칙으로 골랐는지"가 실제 코드와 달라진다. 가드는 `compute-sampling-golden.mjs`에 제대로 구현돼 있는데 **그 스크립트를 실행하는 코드가 레포에 없다**(package.json lint/test·run-smoke 모두 미호출). `run-smoke.mjs:452`는 수집기 출력을 ②와 비교하므로 ①에 대해 항진명제이고, 골든 게이트는 ④만 읽는다. 반대 방향(②만 변조)은 `--golden`이 잡는다 — "정본을 고치고 사본을 잊는" 가장 흔한 방향만 정확히 무방비다.
- **수정안**: `assertNoLiteralDrift`(+`extractCanonicalLiteralFromSchema`)를 `scripts/lib/`로 옮겨 ①의 description에서 리터럴을 추출해 ②와 대조하는 검사로 만들고, 이를 `validate-plugin.mjs`의 기본 검사(`runValidation`)에 넣어 `npm run lint`에서 항진명제 없이 실행되게 한다. 최소한 `run-smoke.mjs` 기본 스모크에 "스키마 description에서 추출한 리터럴 === CANONICAL_SAMPLING_METHOD_LITERAL" 단정을 추가한다(디스크 I/O 1회, 골든 게이트 대기 불필요).

## A-20. 머지 판정의 「유일한 정본」이 스키마에서 두 필드로 이중 선언되고, 그 둘을 묶는 AC-6 (iii) 검사를 인용 검증기가 호출하지 않아 `isMerge` 한 글자로 머지 규칙 두 개가 동시에 꺼진다 — Major

- **위치**: `schemas/evidence.schema.json:203`(parents "머지 판정의 유일한 정본")·`:207`(isMerge "이 값이 머지 판정의 유일한 정본"), `scripts/verify-evidence.mjs:186-193`(머지 해시 basis 규칙 — `ledgerEntry.isMerge`만)·`:336`((e)축 집합 동치 — `c.isMerge !== true` continue), `scripts/lib/invariants.mjs:161-177`(`checkIsMergeOracleInvariant` — parents로 재계산), `scripts/validate-plugin.mjs:733-739`(그 검사의 유일한 배선 지점)
- **실패 시나리오**: 원장의 머지 커밋 1건에서 `isMerge: true`를 `false`로만 바꾼다(parents는 2건 그대로). 실측: 직전까지 `CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN` FAIL(exit 1)이던 인용이 `total=1 pass=1 fail=0` `[PASS]` exit 0으로 뒤집히고, `mergeFileSet: checked=1 → 0`이 되어 원장 `files[]`와 실제 diff의 집합 동치 검사도 조용히 0건 실행된다. 즉 "머지 해시는 inference 근거로만 허용"과 AC-7 집합 동치 두 계약이 동시에 무력화되는데 검증기는 exit 0을 반환한다. 같은 파일을 `--schema-check`에 넣으면 `EVIDENCE_INVARIANT_AC6_III_VIOLATION`으로 잡히지만, `verify-evidence.mjs`는 `invariants.mjs`를 import조차 하지 않고 README·사용법에 "먼저 `--schema-check`를 돌려야 한다"는 순서 계약도 없다.
- **수정안**: ① 스키마 203/207 중 한쪽의 "유일한 정본" 표현을 걷어내고 관계를 명시한다 — parents가 원천이고 isMerge는 파생 캐시이며 AC-6 (iii)가 동치를 강제한다. ② `verify-evidence.mjs`가 evidence 로드 직후 `checkEvidenceInvariants(evidence)`를 호출해 위반이 있으면 인용 검증 시작 전에 exit 1로 중단하게 한다(import 한 줄로 기존 모듈 재사용). ③ 또는 `verifyCitation`/`verifyMergeFileSetEquivalence`가 `isMerge` 대신 `isMergeCommit(c.parents)`(`scripts/lib/git.mjs:211`)를 쓰도록 바꿔 정본을 parents 하나로 고정한다.

## A-21. §7 정본 git 프리픽스와 (exit code, stderr) 3분류가 프로덕션에 두 곳 구현돼 있고 `store.mjs` 사본은 어떤 게이트도 검사하지 않는다 — Major

- **위치**: `scripts/lib/git.mjs:3-12,45-50,58-80`(정본 + "모든 git 호출은…" 단일 계약 선언), `scripts/lib/store.mjs:30,36-40,52-59`(동일 배열 재정의 + `execFileSync` 직접 호출, 정당화 주석 없음), 호출부 `scripts/collect-git-facts.mjs:140`, `scripts/lib/store.mjs:218,250`, 추가 사본 `fixtures/make-fixture.mjs:92-99`·`fixtures/golden/compute-sampling-golden.mjs:78`(둘은 주석/PROVENANCE로 정당화됨)
- **실패 시나리오**: 결정성 문제로 §7 프리픽스에 옵션을 추가한다(예: `-c core.precomposeunicode=true`, A-12의 `diff.renames`도 여기 해당). `git.mjs`만 고치고 커밋하면 4개 게이트가 전부 녹색이므로 완료로 판단한다(실측: `store.mjs`의 프리픽스를 빈 배열로 만들어도 lint exit 0, 71/88/11 PASS). 이후 `getRepoToplevel`만 옛 프리픽스로 남아 저장 루트(`<repo-key>`) 산출 경로가 사용자 gitconfig의 영향을 받고, 같은 레포가 두 개의 `<repo-key>` 디렉터리로 해석돼 이전 실행 산출물을 못 찾는다. 오늘 당장의 증상도 있다 — 비-git 디렉터리를 `--repo`로 주면 `execFileSync`가 non-zero에서 throw하므로 3분류를 거치지 않고 `fatal: not a git repository` 영어 원문 + `[오류] 수집 실패: Command failed: git -C ...`로 같은 메시지가 두 번 노출된다(한국어 분류 진단이 나와야 하는 자리).
- **수정안**: `store.mjs`에서 자체 `GIT_FIXED_PREFIX_ARGS` 정의를 삭제하고 `import { runGit } from "./git.mjs"`로 바꿔 `getRepoToplevel`을 `runGit(repoPathInput, ["rev-parse","--show-toplevel"])`의 outcome 분기로 재작성한다(비-git/tool-error를 구분해 반환하거나 분류 코드가 담긴 Error를 던진다). 순환 import 없음 — `git.mjs`의 import는 `node:child_process` 하나뿐이다. 남기려면 최소한 상수를 import해 쓰고, tests에 "프로덕션 git 호출 지점이 git.mjs 하나뿐"임을 지키는 grep 성격의 단정을 추가한다. `make-fixture`/`golden` 사본은 "의도적 별도 구현"임을 각 파일 상단에 한 줄로 명시한다.
- **묶은 하위 지적**: 계약 렌즈(Major)·구조 렌즈(Minor) 2건 병합.

## A-22. `fixtures/golden/case-17`과 그 생성기가 인용 필드명을 `evidenceId`로 쓰는데 정본은 `ledgerId` — AC-7 대표 재현 케이스가 의도한 코드가 아니라 MALFORMED로 FAIL한다 — Major

- **위치**: `fixtures/make-fixture.mjs:1199`(`evidence: [{ evidenceId, role }]`), `fixtures/golden/case-17-merge-hash-claim.json:9`, `schemas/career.schema.json:85-110`(`additionalProperties:false`, `required:["ledgerId"]`, properties는 ledgerId·path뿐), `scripts/verify-evidence.mjs:73-74·277·298-306`(`citation.ledgerId`만 읽는다)
- **실패 시나리오**: 누가 AC-7(머지 해시는 inference 근거로만 허용) 회귀 테스트를 붙이려고 커밋된 골든 파일을 검증기에 넣는다. 실측 결과는 `{verdict: FAIL, code: CITATION_MALFORMED_LEDGER_ID, sha: null, message: "ledgerId 'undefined'에서 커밋 해시를 추출할 수 없습니다."}` — git 호출조차 일어나지 않고 머지 해시 basis 규칙(`verify-evidence.mjs:179-196`)은 평가되지 않는다. FAIL이 났으므로 "탐지된다"고 판단해 통과시키면, 그 규칙을 나중에 삭제해도 테스트는 계속 녹색이다. 파일 자신의 `expectedVerifierOutcome`이 "(a)축 사유가 아니라 별도의 머지 해시 정량 주장 위반 코드로 FAIL해야 탐지로 채점한다(AC-7)"고 못 박으므로, 이 필드명으로는 파일이 선언한 오라클 계약을 원리적으로 만족시킬 수 없다. `buildCase17MergeHashInjection`은 tests에서 호출되지 않아 드리프트를 잡을 오라클도 없다.
- **수정안**: `make-fixture.mjs:1199`의 `evidenceId` → `ledgerId`(값은 `commit:<sha>` 권장 — `extractShaCandidate`가 생짜 40자 hex도 받으므로 값은 그대로도 통한다), 스키마에 없는 `role` 필드는 제거하거나 스키마에 추가한다. `node fixtures/make-fixture.mjs --out <dir> --emit-golden`으로 골든을 재생성하고, run-smoke에 이 파일을 읽어 `CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN`이 나오는지 단언하는 절을 추가한다.

## A-23. README.md 등 6개 문서·주석이 「스키마·수집기·검증기는 아직 구현되지 않았다」고 선언하지만 전부 구현돼 있다 — Major

- **위치**: `README.md:9-14`·`:84-85`, `fixtures/README.md:6-9`·`:31-51`(시나리오 표에 `churnKeyDivergence` 누락), `fixtures/golden/PROVENANCE.md:13`, `fixtures/make-fixture.mjs:6-7`, `fixtures/golden/compute-sampling-golden.mjs:7·71`, `scripts/lib/git.mjs:4-6`
- **실패 시나리오**: 새 기여자가 README를 먼저 읽고 "수집 스크립트·검증 스크립트는 아직 구현되지 않았다"를 근거로 `scripts/`를 열어보지 않고 자기 버전의 git 수집기를 새로 쓴다(또는 `fixtures/README.md`를 신뢰해 make-fixture가 참조하는 수집기가 없다고 보고 픽스처 계약을 바꾼다). 실제로는 `schemas/` 7개, `collect-git-facts.mjs` 561줄, `verify-evidence.mjs` 661줄, `validate-plugin.mjs` 814줄, `scripts/lib` 8~9모듈이 존재하고 `npm run lint`/`npm test`가 exit 0으로 돈다. 미구현이 맞는 것은 `skills/`(슬래시 명령 4종, 디렉터리 자체가 없음)와 렌더러뿐이다. 마켓플레이스에서 이 플러그인을 보는 사용자는 README가 스스로 "기능 대부분은 아직 구현되지 않았다"고 말하므로 설치하지 않는다. `validate-plugin.mjs`의 README 검사는 참조→실재 한쪽 방향뿐이어서(배지·상태 디렉터리 토큰·명령 접두사·상대 경로 실재성) 이 모순을 잡지 못한다.
- **수정안**: README의 상태 블록과 명령 표를 현재 상태로 갱신한다 — 스크립트·스키마·테스트 하네스는 구현 완료(`npm run lint`/`npm test`로 확인 가능), 미구현은 skills/슬래시 명령·렌더러로 분리 표기. `fixtures/README.md`·`PROVENANCE.md`·`make-fixture.mjs:6`·`compute-sampling-golden.mjs:7,71`의 "아직 존재하지 않는다"를 "이 파일은 의도적으로 수집기를 참조하지 않는다(독립 오라클)"로 고쳐 쓴다 — 사실 진술이 아니라 설계 의도가 원래 하려던 말이다. `fixtures/README.md` 표에 `churnKeyDivergence` 행을 추가한다. 재발 방지는 문장 파싱보다 "상태 문단을 파일 목록 열거 대신 `npm run lint`/`npm test` 실행 결과로 대체"가 싸다.
- **비고**: 두 렌즈가 각각 Major/Minor로 평가했다. 런타임 영향은 0이지만 신규 클론이 볼 수 있는 유일한 정본 문서가 코드와 정반대라는 점에서 Major로 올렸다 — 수정 비용이 10분이므로 우선 처리 대상이다.

## A-24. `%TEMP%` 픽스처 캐시·임시 디렉터리가 무한히 누적된다 — 회수 코드가 없고 정리 호출이 finally 밖에 있다(관측 25MB / 9,270 파일) — Minor

- **위치**: `tests/run-smoke.mjs:1423-1426`(`GOLDEN_CACHE_DIR = os.tmpdir()/devcareer-golden-cache-v1-<make-fixture.mjs 내용 해시>`), `:1469`(현재 키 디렉터리만 삭제), `fixtures/make-fixture.mjs:1300-1327`(`mkdtempSync` ↔ `rmSync`가 try/finally로 묶이지 않음)
- **실패 시나리오**: `make-fixture.mjs`를 1바이트라도 고치면 새 해시 → 새 디렉터리에 300커밋 레포를 다시 만들고 이전 해시 디렉터리는 아무도 지우지 않는다(주석도 "OS temp 정리에 맡긴다"고 명시). 20회 수정이면 약 80MB / 28,500 파일이 적재되고, Windows Defender·인덱서가 매번 이 트리를 훑어 이후 테스트가 느려진다. 별개로 픽스처 생성(~85초) 중 Ctrl-C를 누를 때마다 `devcareer-fixtures-*`가 하나씩 영구 잔류한다 — 실측으로 6초 뒤 kill해 새 잔여물 1개 생성을 재현했고, 세션 시작 시점 `%TEMP%`에 이미 6개 디렉터리 25MB / 9,270 파일이 쌓여 있었다.
- **수정안**: ① `make-fixture.mjs`의 `main()`을 `try { ... } finally { if (cleanup) fs.rmSync(baseDir, {recursive:true, force:true}); }`로 감싸고 `process.on("SIGINT")`에도 같은 정리를 등록한다. ② `ensureLarge300Fixture()`에서 캐시 생성 전에 `os.tmpdir()`을 훑어 현재 해시가 아닌 `devcareer-golden-cache-v1-*`와 `devcareer-fixtures-*`를 회수한다(최근 1~2개 보존 정책도 가능). ③ 캐시 경로를 `os.tmpdir()/devcareer-cache/` 단일 부모 아래로 모으고 `npm run clean`을 제공한다.

## A-25. `.gitattributes`의 `eol=lf` 세 줄과 `validate-plugin.mjs`의 `LF_ENFORCED_TOP_DIRS`가 수기 미러다 — 한쪽만 바뀌면 정상 Windows 체크아웃에서 lint가 구조적으로 통과 불가해진다 — Minor

- **위치**: `.gitattributes:8-10`, `scripts/validate-plugin.mjs:88-101`(주석이 스스로 "거울 반영"이라 인정)·`:548-558`
- **실패 시나리오**: 누가 `.gitattributes`에서 `fixtures/**/*.mjs text eol=lf` 한 줄을 지운다. `core.autocrlf=true`인 Windows 개발자가 클론하면 fixtures/*.mjs가 CRLF로 체크아웃되고 실측대로 `CR_IN_WORKING_TREE` 2건 FAIL이 난다 — 워킹 트리는 git이 지정한 대로 정상인데 게이트를 통과할 방법이 없고, 오류 메시지는 "LF 고정 대상(.gitattributes eol=lf)인데"라며 **이제는 존재하지 않는 규칙**을 근거로 제시하므로 원인 추적이 어렵다. 반대로 새 경로를 `.gitattributes`에만 추가하면 CR 가드가 완화 규칙(CRLF 일관이면 통과)을 적용해 조용히 넘어간다. `.gitattributes`를 파싱해 이 목록을 유도하는 코드는 레포에 없다.
- **수정안**: `validate-plugin.mjs`가 검사 루트의 `.gitattributes`를 읽어 `text eol=lf` 속성이 붙은 패턴 라인을 파싱하고 그로부터 LF 고정 대상을 유도하게 한다(`<glob> text eol=lf` 한 형태만 지원해도 충분하며 지원 범위 밖 패턴은 경고). 전면 파싱이 과하면 최소한 "`.gitattributes`의 eol=lf 라인 집합 === `LF_ENFORCED_TOP_DIRS`에서 재구성한 집합" 단정을 lint에 추가한다.

## A-26. `computeSampling`이 `Math.min(...population)`으로 스프레드해 모집단이 약 12만 5천을 넘으면 RangeError로 죽는다 — Minor

- **위치**: `scripts/lib/sampling.mjs:148-149`, 동일 패턴 `fixtures/golden/compute-sampling-golden.mjs:254-255`
- **실패 시나리오**: 20만 커밋 모노레포나 임포트 히스토리 레포에 `--all-identities --max-commits 1000`으로 수집하면(또는 한 identity의 커밋이 12만 건을 넘으면), 수십 분간 git diff를 다 돌린 뒤 마지막 샘플링 단계에서 `[오류] 수집 실패: Maximum call stack size exceeded`로 끝난다. 산출물은 0건이고 원인 진단도 불가능하다. 실측(Node v24.15.0, 실제 모듈 import): 100,000 OK / 130,000 RangeError / 200,000 RangeError. 기본 실행 경로(`--since/--until` 미지정 → `??`가 undefined를 타고 스프레드 실행)가 곧 취약 경로다.
- **수정안**: `population.reduce((m,c)=>Math.min(m,c.authorEpochSec), Infinity)` 형태의 순회로 바꾼다(골든 재계산 스크립트도 함께).

## A-27. `git-facts.period`의 earliest/latest를 `%aI` 문자열의 사전순 비교로 구해 타임존 오프셋이 다른 커밋 사이에서 순서가 뒤집힌다 — Minor

- **위치**: `scripts/collect-git-facts.mjs:322-323`(문자열 `<`/`>` 비교), `:236`(finalCommits에 `authorEpochSec` 누락 — 근본 원인), `scripts/lib/git.mjs:178`(LOG_FORMAT은 `%aI`·`%at` 둘 다 수집)
- **실패 시나리오**: 해외 근무·원격 협업으로 커밋 타임존이 섞인 레포에서 `period.earliest/latest`가 실제 최초/최종 커밋과 다른 커밋을 가리킨다. 실측: `2024-03-01T09:00:00+09:00`(실제 최초)과 `2024-03-01T01:00:00-05:00`(실제 최종) 두 커밋 레포에서 `{"earliest":"2024-03-01T01:00:00-05:00","latest":"2024-03-01T09:00:00+09:00"}` — **둘 다 뒤집혔다**. 경계일에 걸리면 경력 기간 서술이 하루 어긋난다. evidence 쪽 정렬은 `authorEpochSec`를 쓰므로 올바르다 — 같은 레포 안에 올바른 구현이 병존한다.
- **수정안**: finalCommits에 `authorEpochSec`를 실어 보내고(스키마 노출을 피하려면 `buildGitFacts`에 별도 인자로 전달) epoch로 min/max를 구한 뒤 출력은 해당 커밋의 `authorDate` 문자열을 쓴다. 임시 방편으로 `Date.parse(c.authorDate)` 비교도 가능하다.

## A-28. 자작 스키마 검증기가 `anyOf`와 최상위 `if/then`을 「지원 키워드」로 선언하고도 평가하지 않으며, 미지원 경고 대상에서도 빠져 조용히 통과시킨다 — Minor

- **위치**: `scripts/lib/schema-validate.mjs:5-9`(주석의 지원 목록)·`:30-38`(`KNOWN_SCHEMA_KEYWORDS`), `:152-266`(`validateInstance` — `anyOf` 분기 없음), `:161-165`(경고 루프는 KNOWN 밖만 본다), `:167-174`(oneOf만 평가), `:250-263`(if/then은 `allOf` 원소로 들어온 경우만)
- **실패 시나리오**: 누가 nullable 필드를 `"anyOf":[{"type":"string"},{"type":"null"}]`로 표현한다(`state.schema.json`이 이미 oneOf로 같은 패턴을 쓰므로 자연스러운 선택이다). 그 필드에는 숫자·객체·배열 무엇이든 들어가도 `--schema-check`가 PASS하고 경고도 없어 "검증되지 않았다"는 사실조차 관측되지 않는다. 실측: `{v:{anyOf:[{type:"string"},{type:"null"}]}}` + `{v:12345}` → errors=[] warnings=[]; 최상위 `if/then` 조건부 required도 → errors=[] warnings=[]. 현재 `schemas/*.json` 7개는 이 패턴을 쓰지 않아 잠재 결함이다.
- **수정안**: `anyOf`에 oneOf와 같은 "최소 1개 매칭" 평가를 추가하고, `resolved.if`가 최상위에 있는 경우도 allOf 원소와 동일하게 처리한다. 즉시 구현하지 않으려면 반대로 `anyOf`/`if`/`then`/`else`를 `KNOWN_SCHEMA_KEYWORDS`에서 빼서 사용 시 `SCHEMA_UNSUPPORTED_KEYWORD` 경고가 나게 하고 상단 주석의 지원 목록도 정정한다.

## A-29. 자작 스키마 검증기의 `additionalProperties:false`·`required`가 Object.prototype 키 이름으로 우회된다 — Minor

- **위치**: `scripts/lib/schema-validate.mjs:245`(`!(key in props)`), `:235`(`!(key in instance)`)
- **실패 시나리오**: LLM이 생성한(또는 손댄) `career.json`이 `constructor`·`toString`·`valueOf`·`hasOwnProperty`·`__proto__` 이름으로 검증되지 않은 필드를 실어 나르면서 `additionalProperties:false` 스키마를 통과한다. 실측: `{"id":"a","evil":1}` → REJECTED / `{"id":"a","toString":"AKIAIOSFODNN7EXAMPLE"}` → ACCEPTED. 실제 스키마에서도 재현 — `career.json`에 `"constructor"`·`"toString"`을 넣으면 `[PASS] schema-check` exit 0인데 평범한 이름 `evilNormal`은 `additionalProperties 위반`으로 FAIL(대조군 확보). required 축도 프로토타입 키 이름에 대해 공허하게 만족된다. `lang-lint.mjs:29`의 `collectFreeTextPaths`가 **스키마 트리**를 순회해 `x-freeText` 경로만 수집하므로, 스키마에 없는 필드는 언어 린트(AC-19) 대상에도 오르지 않는다 — 스키마 게이트와 언어 게이트를 동시에 우회하는 통로다. (JSON.parse는 `__proto__`를 own property로 만들므로 실제 프로토타입 오염은 발생하지 않는다 — 이 건은 오염이 아니라 검증 우회다.)
- **수정안**: `:245`를 `Object.prototype.hasOwnProperty.call(props, key)`, `:235`를 `Object.prototype.hasOwnProperty.call(instance, key)`로 바꾼다(2줄). 회귀 방지로 `tests/fixtures-invalid/`에 `constructor`/`toString` 추가 필드 케이스를 넣는다.

## A-30. 최상위 디렉터리 이름이 `__proto__`인 레포에서 `git-facts.pathModuleMap` 항목이 조용히 사라진다 — Minor

- **위치**: `scripts/collect-git-facts.mjs:334` (`pathModuleMap[topDir] = (pathModuleMap[topDir] ?? 0) + 1`)
- **실패 시나리오**: 프로토타입 오염 테스트 픽스처를 담은 JS 라이브러리 레포(최상위 `__proto__/` 디렉터리를 두는 관행이 있다)에서 수집하면 그 디렉터리의 모든 작업이 `pathModuleMap`에서 사라진다. `{}` 리터럴이라 `pathModuleMap["__proto__"]` 읽기가 `Object.prototype`(객체)을 반환하고 `?? 0`을 통과하지 못해 `Object.prototype + 1`이 문자열이 되며, `__proto__`에 문자열 대입은 사양상 무시된다 — 카운트가 저장되지 않고 오류도 없다. 실측: `__proto__/a.js` + `src/b.js` 레포에서 `pathModuleMap: {"src":1}`, `extensionHistogram: {".js":2}`(기대: `{"__proto__":1,"src":1}`). 상위 계층이 "어느 모듈에서 일했는가"를 이 집계로 추론하므로 기여가 통째로 빠진 지식맵이 나오고 경고도 없다.
- **수정안**: `pathModuleMap`·`extensionHistogram`·`conventionalCommitTypeDistribution`을 `Object.create(null)` 또는 `Map`으로 만들고(직렬화 시 `Object.fromEntries`), 최소한 `Object.hasOwn(map, key) ? map[key] : 0`으로 읽는다. Map으로 통일하면 `churnByPath`와 구현이 일관되고 이 부류의 특수 키 문제가 구조적으로 없어진다.

## A-31. `sourceRepoHead`가 git 실패 시 조용히 「빈 레포」sentinel(0×40)로 대체된다 — Minor

- **위치**: `scripts/collect-git-facts.mjs:295-299`(`resolveSourceRepoHead` — outcome!=='ok'면 이유 구분 없이 NULL_SHA), `:52`(NULL_SHA 정의 — 주석은 "unborn branch 전용 정본 sentinel")
- **실패 시나리오**: 개발자가 새 실험 브랜치를 `git checkout --orphan`으로 만들어 둔 상태에서 `--ref all`로 전체 히스토리를 수집한다. 실측: `traversed=5 total=5 analyzed=5`인데 `sourceRepoHead=0000...0000`, exit 0, 경고 0줄. 즉 커밋 5건이 담긴 원장의 스테일 판정 앵커가 "커밋 0건 레포"를 선언한다. `state.schema.json:5`가 스테일 판정(AC-22)의 진실 원천을 각 산출물의 `sourceRepoHead`라고 못 박으므로 그 판정이 무의미해지고, `commitHash` pattern이 `^[0-9a-f]{40}$`이라 `--schema-check`도 `[PASS]`를 낸다.
- **수정안**: `hasAnyCommitOnHead(repoPath) === false`일 때만 NULL_SHA를 반환하고, 그 외 실패(tool-error)는 예외를 던지거나 최소한 `console.error`로 명시 경고한 뒤 별도 sentinel/필드로 구분한다. `--ref all` 모드에서 HEAD가 unborn이면 앵커로 `git rev-list --all -1`(또는 원장 첫 커밋 해시)을 쓴다. 필요한 `hasAnyCommitOnHead`는 이미 같은 파일이 import해 쓰고 있다(`:140-149`).

## A-32. verify-evidence의 입력 파일 오류가 raw Node 스택 트레이스 + exit 1로 나온다 — 「인용 FAIL」과 종료 코드가 구별되지 않고 JSON 파싱 오류는 파일명도 알려주지 않는다 — Minor

- **위치**: `scripts/verify-evidence.mjs:492-494`(`readJson` — try/catch 없음), `:558-570`(`loadArtifactsByLayer`), `:622·626`(evidence/config 로드), `:648`(`process.exit(report.ok ? 0 : 1)`), 헤더 주석 `:54-56`(exit 1의 정본 의미 선언)
- **실패 시나리오**: 상위 스킬이 `verify-evidence.mjs ... --out-dir <저장루트>`를 실행하고 exit 1을 받는다. 실제 원인은 이전 실행이 중단되어 `gap-report.json`이 반쯤 쓰인 상태(또는 경로 오타)인데, 스킬은 규약대로 "인용 무결성 위반 — 근거 없는 주장이 탐지되었다"로 해석해 잘못된 진단을 보고하고 LLM에게 문장 수정을 지시하는 무의미한 루프에 들어간다. 실측: 손상된 career.json → `SyntaxError: Unexpected end of JSON input` + 스택(어느 파일인지 메시지에 없다 — `--artifact` 다중 지정 시 특정 불가), exit 1; 없는 `--evidence` 경로 → `ENOENT` 스택 7줄, exit 1. 같은 레포의 `collect-git-facts.mjs`와 이 파일의 인자 오류는 이미 exit 2를 쓰므로 내부 비일관성이기도 하다.
- **수정안**: `readJson`을 try/catch로 감싸 오류 메시지에 항상 파일 경로를 포함시키고(`${p} 읽기/파싱 실패: ${e.message}`), `main()` 전체를 try/catch로 감싸 입력·환경 오류는 `[오류] ...` 한 줄과 함께 **exit 2**로 종료한다(0=PASS / 1=검증 FAIL / 2=실행 불가). 이 3분기 계약을 README와 헤더 주석에 명시한다(A-1의 파서 예외, B-1의 fail-open 수정과 같은 종료 코드 체계를 공유해야 한다).

## A-33. 상태 디렉터리 이름 상수의 정본을 import한 `validate-plugin.mjs`가 같은 파일에 `.devcareer` 리터럴 사본을 두고, AC-3(a) 일치 검사는 README·.gitignore만 스캔한다 — Minor

- **위치**: `scripts/validate-plugin.mjs:86`(하드코딩 사본 `ALWAYS_EXCLUDED_DIR_NAMES`), `:118-121`("이 파일은 그 상수를 참조만 하고 재정의하지 않는다"), `:340-378`(`checkStateDirConsistency` — refFiles가 README.md·.gitignore 2개), `schemas/config.schema.json:5,134`, `schemas/state.schema.json:5`, `scripts/lib/store.mjs:9-10,203,206`
- **실패 시나리오**: §9 상태 디렉터리 이름을 `.devcareer` → `.devcareer-store`로 바꾼다. 검사가 README·.gitignore만 지적하므로 그 둘만 고치면 lint가 통과한다(실측 exit 0). 결과 (a) `:86`의 제외 목록은 구 이름을 가리키므로 레포 내부 저장(`--storage repo`)을 쓰는 사용자의 레포에서 lint를 돌리면 개인 경력 데이터가 담긴 `.devcareer-store/*.json`이 CR 가드 순회 대상이 되어 `CR_IN_WORKING_TREE` 오탐 FAIL(실측), (b) `config.schema.json`·`state.schema.json`의 description은 존재하지 않는 `~/.devcareer/<repo-key>/`를 저장 루트 정본이라 계속 설명한다.
- **수정안**: ① `:86`의 `".devcareer"`를 이미 import한 `STATE_DIR_NAME`으로 교체한다. ② `checkStateDirConsistency`의 refFiles에 `schemas/*.json`을 추가한다(스키마 description은 백틱 없는 평문이므로 평문 토큰 추출을 하나 더 붙인다). ③ `store.mjs` 주석의 `~/.devcareer/` 표기도 같은 범위에 넣거나 상수 보간으로 바꿔 문자열이 한 곳에서만 나오게 한다.

## A-34. L1+ 산출물 계층 enum이 두 프로덕션 스크립트에 각자 하드코딩돼 있고 미지의 계층은 오류 없이 조용히 스킵된다 — Minor

- **위치**: `scripts/validate-plugin.mjs:629`(`const layers = ["career","knowledge-map","gap-report","plan"]`)·`:631`(`if (!fileExists(instPath)) continue;`), `scripts/verify-evidence.mjs:76-82`(`KNOWN_LAYERS`·`LAYER_PARENT`)·`:530`·`:563-568`
- **실패 시나리오**: 새 산출물 계층(예: `interview.json` + 스키마)을 추가하고 `verify-evidence.mjs`에만 등록하면 `--lang-check`가 그 파일을 조용히 건너뛰어 `x-freeText` 필드가 전부 영어여도 AC-19 언어 린트가 0건 위반으로 통과한다. 반대로 `validate-plugin`에만 등록하면 `verify-evidence --out-dir`이 자동 탐색에서 빼먹어 그 안의 모든 인용이 검증 없이 남는데도 `[PASS]` exit 0이 난다. 두 경우 모두 경고가 없고, 두 목록의 동일성이나 `schemas/` 실재 집합과의 대조 검사도 없다. README가 L0~L5를 선언하므로 계층 확장은 계획된 변경이다.
- **수정안**: 계층 목록과 부모 관계를 `scripts/lib/layers.mjs`(`ARTIFACT_LAYERS`, `LAYER_PARENT`)로 옮겨 두 스크립트가 import하게 한다. 그 목록을 `schemas/<layer>.schema.json` 실재 집합과 대조하는 검사를 lint에 추가하면(evidence·config·state는 산출물이 아니므로 명시 제외) 스키마만 추가하고 등록을 잊는 경로도 FAIL로 관측된다.

## A-35. `plugin.json`·`marketplace.json`·`package.json`의 version·description·keywords가 완전 중복인데 일관성 검사는 name과 license만 대조한다 — Minor

- **위치**: `.claude-plugin/plugin.json:2-4,9,11-20`, `.claude-plugin/marketplace.json:13-16,20-29`(+ `metadata.version`), `package.json:2-4,9`, `scripts/validate-plugin.mjs:396-458`(`checkNamingConsistency`)
- **실패 시나리오**: 0.2.0 릴리스에서 plugin.json·package.json의 version만 올리고 marketplace.json의 `metadata.version`·`plugins[0].version`을 잊는다. `npm run lint`가 exit 0으로 통과하므로 그대로 태그·푸시된다. `/plugin marketplace add`로 등록한 사용자는 목록에서 0.1.0을 보고 설치한 플러그인은 0.2.0을 보고해 실제 버전을 알 수 없다. description(145자, 완전 동일)·keywords(8개, 순서까지 동일)를 한쪽만 고친 경우도 같다. `version`을 파일 간에 대조하는 코드는 레포 전체 0곳이다(`REQUIRED_PLUGIN_FIELDS`는 존재 여부만 본다).
- **수정안**: `checkNamingConsistency`에 세 파일 `version` 동일성 검사(`PLUGIN_VERSION_MISMATCH`)와 plugin.json ↔ marketplace.json `plugins[n]`의 `description`·`keywords` 동일성 검사를 추가한다. 근본적으로는 marketplace.json의 중복 필드를 지우고 plugin.json을 유일 출처로 두는 편이 낫다(플랫폼이 허용하는 범위에서).

## A-36. `npm test`가 71개 동일 단언과 동일 픽스처 생성을 두 번 반복한다 — `--negative`가 기본 스모크 10개 섹션을 그대로 다시 돈다 — Minor

- **위치**: `tests/run-smoke.mjs:1706-1745`(main — 10개 runSection이 두 모드에 공통), `package.json:15-16`(같은 파일 3회 호출), `tests/run-smoke.mjs:566-572·1006-1010·1096-1099·1196-1198·1268-1270`(buildRename 4회·buildBotCommits 3회·buildMerge 2회 재생성)
- **실패 시나리오**: 개발자가 negative 픽스처 하나만 고치고 `--negative`로 확인하려 하는데, 플래그 이름과 달리 40초~100초 동안 git 서브프로세스 수백 개를 띄운다. 실측: 두 실행의 PASS 라벨을 정렬 비교하니 공통 71건 / default 전용 1건 / negative 전용 18건 — 71건이 문자열 단위로 완전히 중복된다. 반복 주기가 길어져 "테스트를 자주 돌리지 않는" 습관이 생기고, 실패 출력에서 어느 단언이 negative 스위트 소속인지 구분하기 어렵다.
- **수정안**: 공통 섹션을 배열로 뽑아 `--negative`일 때는 negative 스위트만 돌리도록 분기한다(또는 공통 섹션을 한 번만 도는 단일 실행으로 통합하고 `package.json`의 test를 1회 호출로 줄인다). 섹션 간 픽스처 재생성은 모듈 스코프에 "생성 1회 + 재사용" 캐시(`ensureLarge300Fixture` 패턴)를 두어 없앤다.

## A-37. 주석과 실행 로그가 `collect-git-facts.mjs:193`이라는 절대 행 번호를 하드코딩해 참조한다(5곳, 그중 2곳은 실제 출력) — Minor

- **위치**: `tests/run-smoke.mjs:417`(주석)·`:429`(`console.log` 출력 문자열)·`:477`(주석), `fixtures/make-fixture.mjs:1028`(주석)·`:1116`(report 라벨 — 실패 출력에 그대로 찍힌다), 대상은 `scripts/collect-git-facts.mjs:193`(`churn: diff.insertions + diff.deletions`)
- **실패 시나리오**: 누가 `collect-git-facts.mjs` 상단(import 블록이나 `DEFAULT_BOT_PATTERNS`)에 두 줄을 추가한다. 이후 이 테스트가 실패하면 로그는 여전히 "193행을 보라"고 안내하는데 193행은 무관한 코드다. 디버깅하는 사람이 로그 자체를 신뢰하지 않게 되거나 엉뚱한 곳을 고친다. 193행 내용을 대조하는 테스트는 없으므로 틀려졌음을 알려 주는 장치가 없다.
- **수정안**: 행 번호를 지우고 검색 가능한 식별자로 참조한다 — "`collect-git-facts.mjs`의 `enriched` 매핑에서 churn 파생식(`diff.insertions + diff.deletions`)". 특히 `console.log`/report 라벨의 행 번호를 제거한다.

## A-38. CLI가 광고하는 `--include-diff`가 완전한 no-op이고, `CO_AUTHOR_LINE_RE` 등 참조 0건인 선언이 남아 있다 — Minor

- **위치**: `scripts/collect-git-facts.mjs:20`·`:289-290`(`void includeDiff;`), `:449-451`·`:478-480`(parseArgs·usage에 노출), `scripts/lib/git.mjs:180`(`CO_AUTHOR_LINE_RE` — 참조 0건, 실동작은 `:198`의 인라인 `/^co-authored-by:/i`), `scripts/lib/schema-validate.mjs:61`(`walkSchemaNodes`), `scripts/lib/lang-lint.mjs:29·49`(모듈 밖 사용 0건)
- **실패 시나리오**: 사용자가 usage를 보고 `--include-diff`로 코드 원문 인용을 켰다고 믿는다. 실측 결과 플래그 유/무의 산출물 차이는 `generatedAt`과 그 파생값 `contentHash`뿐 — 관측 가능한 효과 0, 경고 0이라 옵트인 반영 여부를 확인할 방법이 없어 스니펫이 없는 이유를 다른 곳에서 계속 찾는다. 별도로, 트레일러 판정 규칙을 고치려는 사람이 눈에 띄는 `CO_AUTHOR_LINE_RE`(multiline 플래그까지 붙은 그럴듯한 상수)만 수정하면 동작이 하나도 바뀌지 않는다(두 정규식은 의미도 다르다 — 미사용 상수는 본문 다중행 매칭, 실동작은 trim된 한 줄 접두 매칭).
- **수정안**: `--include-diff`는 미구현임을 stderr에 명시 경고하거나 usage·parseArgs에서 구현 시점까지 제거한다. `CO_AUTHOR_LINE_RE`를 삭제하거나 `parseCoAuthorTrailers`가 그 상수를 쓰도록 통합해 정규식 정의를 한 곳으로 모은다. 모듈 밖에서 쓰이지 않는 export는 내부 함수로 되돌리거나 테스트용이라면 `git.mjs`의 `_internal` 패턴처럼 의도를 표시한다.

---

# B. may-be-intentional — 설계 의도가 있을 수 있어 설계 문서와 대조 필요 (3건)

## B-1. verify-evidence가 fail-open 한다 — git 오류가 나면 인용 100%가 미검증인데도 `[PASS]` + exit 0을 출력하고 가짜 커밋 해시가 통과한다 — Critical

- **위치**: `scripts/verify-evidence.mjs:465`(`const ok = violations.length === 0 && layerRefViolations.length === 0 && mergeFileSetViolations.length === 0;` — `toolErrors`도 `passCitations`도 산식에 없다), `:606`·`:648`(`[PASS]` 출력과 `process.exit(report.ok ? 0 : 1)`), `:151`·`:191`(tool-error → TOOL_ERROR 판정), `scripts/lib/git.mjs:60-65`(`LOOKUP_FAILED_STDERR_PATTERNS`에 'not a git repository' 없음)·`:73-80`·`:102-111`
- **왜 may-be-intentional인가**: 파일 헤더 주석(`:57-58`)이 "도구 오류만 있는 경우도 exit 0"을 **명시**하므로 이 분리 자체는 의도된 설계로 보인다. 판정 대상은 그 설계의 결과("검증 0건 → PASS 선언")이지 분리 여부가 아니다 — 설계 문서에 이 결과까지 의도했다는 근거가 있는지 확인하라.
- **실패 시나리오**: 상위 스킬이나 사용자 스크립트가 `verify-evidence.mjs`를 실행하고 종료 코드만 보고 "인용 무결성 검증 통과"를 보고한다. `--repo`에 레포 루트 대신 상위 디렉터리를 넣었거나(오타 1글자), git이 PATH에 없는 셸에서 실행했거나, 레포를 옮긴 상태라면 LLM이 만들어낸 존재하지 않는 커밋 해시를 근거로 단 한 건도 검증하지 않은 채 `[PASS]` exit 0이 나온다. 실측(실제 커밋 1건 + 가짜 해시 `dead0000...` 1건 인용): 정상 `--repo` → `total=2 pass=1 fail=1`, `[FAIL] CITATION_COMMIT_NOT_FOUND_IN_REPO`, exit 1(의도대로) / 비-git 디렉터리 → `total=2 pass=0 fail=0 toolError=2`, `[TOOL_ERROR] fatal: not a git repository`, 그리고 `[PASS] verify-evidence` exit 0 — 가짜 해시가 아무 FAIL 없이 통과했다. README가 "모든 인용의 실재성은 LLM이 아니라 스크립트가 검증한다"·"가짜 커밋 해시 100% 탐지"를 약속하는 유일한 집행 지점이 이것이다.
- **수정안**: ① `ok` 판정에 도구 오류를 반영하고 종료 코드를 3분기로 분리한다 — `toolErrors.length > 0`이면 `INCONCLUSIVE`로 보고하고 **exit 2(검증 불가)**, PASS=0 / FAIL=1을 유지해 호출자가 구조적으로 fail-open 못 하게 한다(A-32의 3분기 계약과 통일). ② 최소한 `passCitations === 0 && totalCitations > 0`이면 절대 `[PASS]`를 출력하지 않는다. ③ 시작 시 `git rev-parse --is-inside-work-tree`로 `--repo`를 1회 선검사해 그 자리에서 exit 2로 중단한다. ④ `evidence.json`의 `sourceRepoHead`가 `--repo`에 실재하는지 확인해 "엉뚱한 레포를 가리켰다"를 조기에 잡는다(A-7의 스테일 검사와 동일 지점).

## B-2. 분석 대상이 아닌 타인 커밋 전량(이메일·제목·co-author·변경 경로)이 `max_commits` 예산과 무관하게 evidence.json에 수록된다 — Critical

- **위치**: `scripts/collect-git-facts.mjs:230`(`finalCommits` 필터 `c.excluded || selectedHashSet.has(c.hash)`), `:235·239·240`(제외 커밋도 `authorEmail`/`coAuthors`/`subject`를 동일 직렬화), `:216-221`(샘플링은 `population = enriched.filter(c => !c.excluded)`에만 적용)
- **왜 may-be-intentional인가**: 제외 커밋을 전량 등재하는 구조 자체는 `scripts/lib/invariants.mjs`의 `checkCoverageTraversedInvariant`(traversed === total + 제외 건수)와 `checkCommitLevelSumInvariant`가 요구하는 것으로 보이므로 의도적일 수 있다. 다만 그 불변식들은 제외 커밋 레코드의 **개수**와 insertions/deletions/files만 읽고 `authorEmail`·`subject`·`coAuthors`는 읽지 않으며, `verifyCitation`도 `excluded===true`에서 `authorEmail`에 닿기 전에 FAIL한다 — 즉 **PII 3필드를 읽는 검사가 하나도 없는데 실려 나간다**. 트리아지 질문은 "제외 커밋 등재"가 아니라 "그 레코드에 PII 3필드를 담기"가 의도였는지다.
- **실패 시나리오**: 200명이 기여한 사내 모노레포(커밋 20만, 본인 500)에서 `max_commits: 1000`으로 실행한다. `coverage.analyzed`는 500이지만 `evidence.json`은 19만 9,500건의 타인 커밋을 저자 이메일·커밋 제목·변경 파일 경로까지 담아 생성되고(수백 MB) 이 파일이 LLM 컨텍스트로 전달된다. 커밋 제목에는 통상 내부 코드네임·고객사명·장애 내용이 들어 있어, 사용자는 본인 이력서를 만들려다 회사 기밀과 동료 200명의 업무 이력을 외부로 유출한다. **예산을 줄여도 유출량은 0건도 줄지 않는다** — 실측(동료 40커밋 + 본인 1커밋, `--max-commits 1`): `coverage.analyzed=1 total=1 traversed=41`인데 `commits[].length=41`, 제외 40건 전부에 동료 이메일·제목 원문(`internal: colleague work N on secret-project-atlas`)·경로·Co-authored-by 트레일러가 보존됐다. README의 한계 고지는 "diff 원문은 전송되지 않는다"만 말하고 이 사실은 언급하지 않는다.
- **수정안**: ① 제외 커밋은 불변식이 실제로 요구하는 필드만 남긴 축소 레코드(`id`/`hash`/`parents`/`isMerge`/`insertions`/`deletions`/`files`/`excluded`/`exclusionReason`)로 직렬화하고 `authorEmail`·`subject`·`coAuthors`를 생략한다(스키마에서 excluded 분기의 required를 분리). `coverage.traversed` 불변식은 레코드 개수만 필요하므로 깨지지 않는다. ② `traversed`가 예산보다 훨씬 큰 실행에서는 제외 커밋을 개별 레코드가 아니라 `excludedSummary: {byReason: {...}, count: N}` 집계로 대체하고 개별 등재는 옵트인으로 둔다 — 이것이 이 도구의 프라이버시 기본값(§6 home 저장)과 일관된다. ③ README 한계 고지에 제외 커밋의 저자·제목·경로 취급을 명시한다.

## B-3. `--all-identities`가 타인 커밋을 `excluded:false, exclusionReason:null`로 기록하고 `selectedIdentities`를 빈 배열로 남겨, 원장이 스스로 「필터 안 걸린 상태」라고 말하지 못한다 — Minor

- **위치**: `scripts/collect-git-facts.mjs:182-186`(`allIdentities && exclusionReason === "author-not-selected"` → `{excluded:false, exclusionReason:null}`), `:255-260`(`coverage.exclusions`), `schemas/evidence.schema.json:102`(그 4필드를 required로 못 박음), CLI 노출 `:431-432`·`:476-480`
- **왜 may-be-intentional인가**: 코드 주석은 "탐색/테스트 전용"이라고 밝히지만 CLI 도움말에 노출된 실사용 가능한 플래그이고, `--identity` 0개일 때의 오류 메시지가 직접 이 플래그를 대안으로 안내한다. 설계 문서가 이 플래그를 테스트 전용으로 규정했는지 확인하라.
- **실패 시나리오**: 사용자가 identity 선택 게이트를 귀찮아하거나 이메일이 여러 개라서 `--all-identities`로 수집한다. `evidence.schema.json`은 `coverage.analyzed`를 "`excluded !== true`인 커밋 기준"으로 정의하므로, 상위 계층이 규정대로 필터하면 타인 커밋을 본인 것으로 읽고 팀원 5명의 작업을 1인칭으로 서술한다. 남는 유일한 신호 `selectedIdentities: []`는 "필터를 끈 상태"와 "identity가 하나도 설정되지 않은 상태"를 구분하지 못한다. 실측(저자 2명): `exclusions {"bots":true,"vendoredPaths":true,"mergeIncluded":false,"selectedIdentities":[]}`, 두 저자 모두 `excl=false reason=null`. README가 "저자 정체성은 추측하지 않는다 … 임의로 '이 커밋은 당신 것'이라고 판단하지 않는다"를 명시적 한계 고지로 약속하는데 이 플래그가 정확히 그 반대를 하고 원장은 그 사실을 자기 안에 기록하지 않는다.
- **수정안**: ① `exclusionReason`을 null로 만들지 말고 `identity-filter-disabled` 같은 별도 값을 남기거나, 최소한 `coverage.exclusions`에 `identityFilterDisabled: true`를 추가해 원장이 자기 상태를 서술하게 한다(스키마 동반 수정). ② `verify-evidence`가 그 플래그를 보면 즉시 FAIL 또는 최상위 경고로 올린다. ③ 실제로 테스트 전용으로 유지하려면 환경변수 게이트 등으로 일반 CLI 표면에서 감춘다.
- **완화 요소(Minor 근거)**: 이 축을 잡는 방어층이 이미 존재하고 발화한다 — `verify-evidence.mjs:164-168`의 (a)축이 `selectedIdentities.includes(authorEmail)`을 검사해 `CITATION_AUTHOR_NOT_SELECTED`로 FAIL을 낸다. 남는 실질 결함은 "검증을 건너뛴 경로에서만 새어나간다"는 좁은 범위다.

---

## 부록 — 이 리뷰가 확인했고 문제가 없었던 축

반증 과정에서 명시적으로 시험해 **견고하다고 확인한** 부분도 기록한다(수정 대상이 아니다).

- **셸 인젝션·옵션 인젝션 없음**: git 호출은 전부 인자 배열이고 셸을 경유하지 않는다. `--repo`가 `-`로 시작해도 `-C`가 값으로 삼으며, 인용 경로·해시는 40자 hex 정규식으로 걸러진 뒤 `<sha>:<path>`로 융합된다.
- **대상 레포 `.git/config`를 통한 코드 실행 없음**: `core.fsmonitor`·`diff.external`·textconv·`core.pager`·`core.hooksPath`를 심어 실행해 봤으나, 이 도구가 쓰는 `git log`/`git diff <tree> <tree>`/`rev-parse`는 인덱스·워킹트리를 건드리지 않아 어느 것도 실행되지 않았다.
- **Windows 고유 축**: 한글·공백 경로, `core.quotepath` 처리, 워크트리 해석은 실측 결과 견고했다.
- **AC-6 교차 불변식·머지 diff 산식·-z 파싱 방어**: 골든과 불변식이 실제로 촘촘하게 물려 있고, 이 리뷰가 시도한 변조 중 `insertions` 조작·`isMerge`↔`parents` 불일치·CRLF 유입은 각각 정확히 잡혔다.
- **리터럴 드리프트 가드 자체의 품질**: `compute-sampling-golden.mjs`의 `assertNoLiteralDrift`, `STATE_DIR_NAME_INCONSISTENT` 검사처럼 필요한 검사를 만들 능력은 이미 여러 곳에서 증명돼 있다 — A-19·A-25·A-33·A-34의 처방은 전부 "그것을 게이트에 연결하는 마지막 한 줄"이다.
