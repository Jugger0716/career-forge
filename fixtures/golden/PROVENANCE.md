# fixtures/golden/ — 생성 근거 (이월 게이트 B-3)

> 대상: `docs/devcareer-prep-plugin/spec.md` 구현 4단계(Phase 0-D).
> 이 문서는 "골든 JSON만 커밋하는 것을 금지한다"는 스펙 요구의 필수 동반
> 산출물이다 — 골든이 어떻게 나왔는지에 대한 독립적 근거 없이는, 잘못
> 구현된 수집기의 출력을 그대로 골든으로 커밋해도 AC-21의 (a)(b)(c)와
> 2회 실행 결정성이 전부 통과해 버린다(잘못된 골든이 곧 규칙이 되는 사고).

## 이 디렉터리에 있는 것과 없는 것

| 파일 | 정본 여부 | 근거 |
|---|---|---|
| `sampling-300.expected.json` | 골든(정본) | `compute-sampling-golden.mjs`가 **정본 `samplingMethod` 리터럴을 리터럴 자체로부터 독립 재구현**해 계산한 결과. `collect-git-facts.mjs`나 `scripts/lib/git.mjs`는 이 레포에 이미 구현돼 있지만, 이 스크립트는 그 둘을 의도적으로 import·참조하지 않는다 — 수집기 구현이 버그를 가지면 같은 버그로 스스로를 검증하는 자기순환이 되기 때문이다(독립 오라클 설계, 아래 리네임·삭제 절과 동일 원칙). |
| `compute-sampling-golden.mjs` | 재계산 스크립트(근거 그 자체) | 실행할 때마다 `schemas/evidence.schema.json`의 `coverage.samplingMethod` description에서 정본 리터럴을 정규식으로 추출해 자신의 하드코딩 사본(`HARDCODED_LITERAL`)과 **완전 일치**하는지 검사한다. 다르면 즉시 예외를 던진다(드리프트 구조적 차단 — 아래 "드리프트 방지 자체 검증" 참조). |
| `case-17-merge-hash-claim.json` | 픽스처 주입 산출물(정본 아님, `fixtures/make-fixture.mjs`의 `merge` 시나리오 선언값을 그대로 반영) | `fixtures/make-fixture.mjs --emit-golden`이 `merge` 시나리오의 실제 머지 커밋 해시로 생성. 리네임/삭제 경로처럼 "무엇이 참인지"는 이 값이 아니라 `make-fixture.mjs`의 `buildMerge()`가 정본이다 — 이 파일은 그 정본 값을 담아 (17) 케이스를 재현 가능하게 만드는 부산물일 뿐이다. |

리네임·삭제 커밋의 `path`/`oldPath`/`changeType` 기대값은 **이 디렉터리에 없다** — B-4가 명시한 대로 `fixtures/make-fixture.mjs`의 `buildRename()`/`buildDelete()` 선언값이 정본이며, 골든과 별개의 오라클이어야 하기 때문이다(수집기·검증기가 `scripts/lib/git.mjs`를 공유하는 한, 원장 대 원장 집합 동치만으로는 그 공유 구현 자체의 `-z` 파싱 버그를 잡을 수 없다).

## `sampling-300.expected.json` 재생성 절차

```bash
# 1. 300커밋 픽스처(및 나머지 전 시나리오)를 임시 디렉터리에 영속 생성
node fixtures/make-fixture.mjs --out <dir>

# 2. 정본 리터럴로부터 독립 재계산(--write 없이 먼저 stdout으로 검토 가능)
node fixtures/golden/compute-sampling-golden.mjs <dir>/large300 --write

# 3. 결정성 재확인 — 별도 임시 디렉터리에 다시 만들어 같은 결과가 나오는지 대조
node fixtures/make-fixture.mjs --out <dir2>
node fixtures/golden/compute-sampling-golden.mjs <dir2>/large300 > /tmp/check.json
diff fixtures/golden/sampling-300.expected.json /tmp/check.json   # 차이 없어야 함
```

`schemas/evidence.schema.json`의 `coverage.samplingMethod` 정본 리터럴이 바뀌면:
1. `fixtures/golden/compute-sampling-golden.mjs`의 `HARDCODED_LITERAL`을 함께 갱신한다(안 하면 다음 재생성 시도에서 즉시 예외로 걸린다).
2. 재계산 알고리즘(`computeSampling`/`selectEvenBucket` 등)이 새 규칙과 여전히 일치하는지 코드 리뷰로 확인한다.
3. 위 재생성 절차를 다시 실행해 골든을 갱신하고, **이 문서도 같은 커밋에서 갱신**한다.

## 재계산 알고리즘이 내린 해석적 결정 (스펙 리터럴이 완전히 명시하지 않은 부분)

정본 리터럴은 규칙의 뼈대를 못 박지만, 다음 세 지점은 리터럴 문자열만으로는 유일하게 결정되지 않아 이 재계산 스크립트가 내린 구체적 해석을 아래에 남긴다(사람 리뷰 시 이 표를 대조 기준으로 쓴다):

| 지점 | 리터럴 근거 | 이 스크립트의 해석 |
|---|---|---|
| even 버킷 구간 소진 시 이월 방향 | `even-backfill=...,carry-to-next-bucket` | 구간 *i*에서 후보가 부족하면 부족분을 구간 *i+1*의 "요구 수"에 더한다(누적 이월). 마지막 구간까지 못 채운 몫은 전체 잔여 풀에서 `(authorDate asc, hash asc)` 순으로 최종 보충한다. |
| even 구간 내 동점 | `min(authorDate)` | 구간 내 후보를 `(authorDate asc, hash asc)`로 정렬해 최솟값을 취한다(리터럴이 `min(authorDate)`만 말하고 그 안의 2차 타이브레이크를 명시하지 않아, 다른 버킷들과 일관되게 `hash asc`를 보편 2차 키로 채택했다). |
| `floor` 처리 후 나머지(remainder) | `remainder→recent` | `K - (floor(K*0.4)+floor(K*0.4)+floor(K*0.2))`를 recent 버킷 크기에 가산한다. 이번 300커밋 픽스처(`K=50`)는 정확히 나누어떨어져(`20+20+10=50`) remainder가 0이므로 이 경로는 이 골든 자체로는 관측되지 않는다 — remainder 처리 로직은 코드 리뷰 대상으로 남는다. |

## 정본 리터럴 변경 이력

| 날짜 | 변경 내용 | 골든 수치 영향 |
|---|---|---|
| (콜드 리뷰 라운드 대응) | `churn:(commitLevelInsertions+commitLevelDeletions desc)` → `churn:(nonVendoredChurn desc)` + `churnDef=...` 절 추가. churn 랭킹 값이 vendored/lockfile 경로(node_modules, dist, vendor, *.lock, package-lock.json, pnpm-lock.yaml, go.sum, composer.lock, poetry.lock, migrations)를 제외한 합으로 바뀌었다 — lockfile 갱신 커밋이 churn 표본을 독식해 실제 작업 커밋이 밀려나는 문제 대응. `scripts/lib/sampling.mjs`의 `CANONICAL_SAMPLING_METHOD_LITERAL`, `schemas/evidence.schema.json`의 `coverage.samplingMethod` description, 이 스크립트의 `HARDCODED_LITERAL` 세 곳을 함께 갱신했다. | **없음** — `large300` 픽스처(`fixtures/make-fixture.mjs` `buildLarge300`)는 `data/`·`deps/`·`contrib/`·`side/` 접두사만 쓰고 vendored/lockfile 경로를 전혀 포함하지 않으므로, 이 정의 변경은 `sampling-300.expected.json`의 선택 집합·버킷 크기·수치 어느 것도 바꾸지 않는다(재생성 절차로 재확인됨, diff 0바이트). |

## 실측 검증 기록

| 항목 | 실행 결과 |
|---|---|
| `node fixtures/make-fixture.mjs` 2회 실행 → stdout 매니페스트(경로 제외) diff | 0바이트 차이(동일) |
| `node fixtures/golden/compute-sampling-golden.mjs <dir>/large300` 서로 다른 두 `--out` 빌드에 대해 각각 실행 → 결과 diff | 0바이트 차이(동일) — `selectedCommitHashesSorted` 50건 포함 |
| `coverage` 기대값(AC-21 B-1/B-2) | `traversed=300`, `total=250`, `analyzed=50`, `droppedCommits=200` — `analyzed <= total < traversed` 부등식 충족 |
| 리터럴 드리프트 가드 자체 검증 | `HARDCODED_LITERAL`을 의도적으로 한 글자 바꾸고 재실행 → 즉시 예외로 실패 확인 후 원복 |
