# fixtures/ — 결정적 골든 픽스처 생성기 (구현 4단계, Phase 0-D)

대상 스펙: `docs/harness/devcareer-prep-plugin/spec.md` "구현 단계 4. Phase 0-D".
이월 게이트: `docs/harness/devcareer-prep-plugin/plan_critic_findings.md` 게이트 B(B-1~B-6).

`scripts/collect-git-facts.mjs`(L0 수집기)와 `scripts/lib/git.mjs`는 **아직
존재하지 않는다**(다음 구현 단계 몫). 이 디렉터리는 그 수집기가 입력으로 삼을
"실제 git 레포"만 결정적으로 만든다 — evidence.json 생성 자체는 여기서
하지 않는다.

## 사용법

```bash
# 두 번 실행해 커밋 해시가 완전히 같은지 확인(AC-5의 결정성 오라클).
# 매니페스트는 baseDir 경로를 제외하고 헤드 해시·커밋 목록·declared만
# stdout에 출력하므로 두 실행 결과를 그대로 diff할 수 있다.
node fixtures/make-fixture.mjs > /tmp/run1.json
node fixtures/make-fixture.mjs > /tmp/run2.json
diff /tmp/run1.json /tmp/run2.json   # 차이 없어야 함

# fixtures/golden/의 재계산 스크립트처럼 실제 온디스크 레포가 필요한 경우:
node fixtures/make-fixture.mjs --out <dir>            # <dir> 아래 정리 없이 유지
node fixtures/make-fixture.mjs --out <dir> --emit-golden  # + case-17 산출물 갱신
```

## 시나리오 목록과 스펙 대응

| # | 시나리오(스펙 표현) | 함수 | 오라클 대상 AC |
|---|---|---|---|
| 0 | 빈 레포 / unborn branch | `buildEmptyRepo` | AC-6(0커밋 정상 종료) |
| 1 | 1커밋(초기 커밋) | `buildSingleCommit` | AC-5, AC-6 |
| 2 | 다중 저자 | `buildMultiAuthor` | AC-7 (a)축, AC-9 |
| 3 | 봇 커밋(dependabot + github-actions) | `buildBotCommits` | AC-9 |
| 4 | 한글 파일명·한글 커밋 메시지(+ 한글 하위 디렉터리) | `buildKorean` | AC-17 |
| 5 | 공백 포함 경로 | `buildSpacePath` | AC-17 |
| 6 | merge 커밋(단독) | `buildMerge` | AC-6 (iv), AC-7, (17)의 소스 |
| 7 | 리네임 | `buildRename` | AC-7, AC-17(B-4 — `path`/`oldPath` 하드코딩) |
| 8 | 파일 삭제 커밋 | `buildDelete` | AC-7, AC-17(B-4 — 삭제 경로 하드코딩) |
| 9 | 빈 커밋 메시지 | `buildEmptyMessage` | AC-6(subject 처리) |
| 10 | Co-authored-by 트레일러(+ 트레일러 없는 대조 커밋) | `buildCoAuthorTrailer` | AC-6(`coAuthors[]` 비공허성) |
| 11 | node_modules/dist/vendor/*.lock/migrations | `buildVendoredPaths` | §5 기본 제외 규칙 |
| 12 | 가짜 API 키·private key 블록 등(전부 가짜 값) | `buildSecrets` | AC-11(마스킹) |
| 13 | 바이너리 파일 | `buildBinaryFile` | AC-6(`binary: true`) |
| 14 | 300커밋 대량 레포(봇 20 + 타 저자 30 + 소유자 250[정규 240 + 머지 유닛 5×2]) | `buildLarge300` | AC-21(전량) |
| 15-a | 도구 오류: 비-git 디렉터리 | `buildToolErrorNonGit` | 3분류 "도구·레포 오류" 분기 |
| 15-b | 도구 오류: `.git/objects` 손상(loose object 0바이트 절단) | `buildToolErrorCorrupted` | 3분류 "도구·레포 오류" 분기 |
| 16 | 옵트인 스니펫 인용(존재 시점 sha + 삭제 이후 sha) | `buildOptInSnippet` | `git cat-file -e` 성공/128 두 분기 |
| 17 | 머지 해시를 `basis:commit`으로 인용한 산출물 주입 | `buildCase17MergeHashInjection`(→ `fixtures/golden/case-17-merge-hash-claim.json`) | AC-7(머지 해시 정량 주장 FAIL), B-5 |

## 결정성 설계

- 모든 커밋은 `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`/`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`을 env로 고정한다. 시간대는 항상 `+0900`(KST) 고정 — 실행 머신의 로컬 TZ에 의존하지 않는다.
- 모든 git 호출은 `-c commit.gpgsign=false -c core.autocrlf=false`를 추가로 강제한다(사용자 전역 gitconfig가 서명·CRLF 변환을 켜두면 커밋 해시 자체가 비결정적으로 바뀌기 때문 — 이 두 옵션은 스펙 §7의 정본 git 호출 프리픽스가 아니라 이 생성기만의 결정성 안전장치다).
- `Date.now()`/`Math.random()`은 어디에도 쓰지 않는다. 시나리오별 base epoch(`BASE` 상수)로 서로 다른 시나리오의 타임스탬프 범위가 절대 겹치지 않게 했다.
- 300커밋 픽스처는 생성 직후 `verifyLarge300Composition()`이 실제 `git log` 결과로 봇/타 저자/소유자/머지 개수를 재확인하고, 선언값(`declared`)과 다르면 즉시 예외를 던진다(생성기 자체의 구성 실수를 잡는 자기 점검).

## 리네임·삭제 기대값이 `fixtures/golden/`이 아니라 여기 있는 이유 (B-4)

`buildRename()`/`buildDelete()`가 반환하는 `declared.oldPath`/`declared.path`/`declared.changeType`이 정본이다. 구현 5·6단계가 머지 규칙과 (exit code, stderr 패턴) 3분류를 `scripts/lib/git.mjs`에 단일 구현해 수집기·검증기가 공유하도록 못 박았기 때문에, 원장 `files[]` 집합과 검증기의 diff 집합을 대조하는 것만으로는 그 공유 구현 자체의 `-z` 파싱 버그(예: 리네임의 두 경로 중 `oldPath`를 버리고 새 경로만 기록하는 버그)를 원리적으로 잡을 수 없다 — 양쪽이 같은 버그로 똑같이 오염되기 때문이다. 이 파일의 하드코딩된 선언값만이 그 구현과 독립적인 오라클이다.

## `fixtures/golden/`과의 관계

`fixtures/golden/`은 "무엇이 참인지 이 파일이 선언한 값"이 아니라 "정본
`samplingMethod` 리터럴로부터 독립 재계산한 결과"(300커밋 샘플링) 및 그
재계산의 산출물(부산물인 case-17 주입 파일)만 담는다. 자세한 내용과
재생성 절차는 `fixtures/golden/PROVENANCE.md` 참조.
