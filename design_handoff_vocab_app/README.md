# Handoff: 단어장 앱 — 사전 지면 방향 (Industry 디자인 시스템)

## Overview
기존 `Gonnavy/vocab-app`(정적 HTML/JS + localStorage PWA)의 화면을 **"사전 지면"** 방향으로 다시 설계하고, 그 방향으로 동작하는 프로토타입을 만들었습니다. 기능 구조(툴바 · 피드 · 진행률 패널 · 편집 모드 · CSV)는 유지하고, 시각 문법과 일부 기능 정의를 아래처럼 바꿨습니다.

핵심 변경 4가지:
1. 상태를 **색이 아니라 채움·무게**로 표현(암기 = 스틸 채움, 중요 = 잉크 밑줄/북마크, 미암기 = 빈 칸). 다크 모드는 톤만 뒤집으면 성립.
2. 진행률은 **항상 20칸(칸당 5%)** 막대 — 단어 1개 = 1칸이 아니며, 반올림하지 않고 5%를 넘을 때마다 왼쪽부터 한 칸씩 찬다. **중요 단어는 암기와 무관하므로 별도의 얇은 20칸 스트립**으로 분리.
3. **무작위는 토글**. 켜면 표시 순서만 섞이고(원본 배열·진행률 칸·분류 목록은 그대로), 끄면 원래 정렬 + 누르기 전 보던 위치로 복귀.
4. **간격 반복(SRS) 복습 세션** 추가 — 기한이 된 단어를 한 장씩. 암기함 → 단계 +1(1·2·4·8·16·32일), 다시 보기 → 단계 0(오늘 재출제).

## About the Design Files
이 번들의 `단어장 프로토타입.dc.html` / `단어장 디자인 시안.dc.html`은 **HTML로 만든 디자인 레퍼런스**입니다. 의도한 외형과 동작을 보여주는 프로토타입이며, 그대로 제품에 올릴 코드가 아닙니다. 할 일은 이 디자인을 **대상 코드베이스의 기존 환경과 패턴으로 재구현**하는 것입니다.

- 현재 저장소(`Gonnavy/vocab-app`)는 빌드 없는 정적 HTML + `app.js` / `store.js` / `csv.js` + localStorage 구조입니다. 그 구조를 유지한다면 프로토타입의 상태 모델과 스타일 값을 `app.js` / `style.css`에 옮기는 방식이 가장 짧습니다.
- 프레임워크를 새로 정한다면(React 등) 아래 "State Management"의 상태 모델을 그대로 스토어로 옮기면 됩니다.
- 프로토타입은 인라인 스타일 + 런타임 CSS 변수로 테마를 뒤집습니다. 실제 구현에서는 `:root` / `[data-theme="dark"]` 토큰 세트로 옮기는 것이 자연스럽습니다.

## Fidelity
**High-fidelity.** 색·타이포·간격·상호작용이 확정된 상태입니다. Industry 디자인 시스템 토큰(아래 Design Tokens)을 그대로 쓰고, 픽셀 값도 명시된 수치를 따르세요. 단, 아이콘은 Lucide(stroke-width 1.5) 한 세트만 사용하고 이모지·다른 아이콘 세트를 섞지 않습니다.

## Screens / Views

### 1. PC 기본 화면 (1180~1400 폭 기준)
사용자가 하루에 수십 번 보는 기본 화면. 위에서 아래로 시스템 바 → (보기 드로어) → 2열 그리드(피드 | 진행률 패널).

**시스템 바** — `display:flex; align-items:center; flex-wrap:wrap; row-gap:10px; white-space:nowrap; border-bottom:1px solid var(--rule); padding-bottom:11px`
그룹은 `padding:0 20px; border-left:1px solid var(--rule-soft)`로 나뉩니다.
- 브랜드: "단어장" 19px/600, 옆에 `N WORDS`(Barlow Condensed 12px, letter-spacing .1em, muted)
- 파일 그룹: 열기 · 내보내기 (13.5px, Lucide `folder-open` / `download` 15px)
- 학습 그룹: 모드 세그먼트(암기 · 의미 · 단어 — 12.5px, padding 4px 11px, 활성 = 잉크 배경 + 페이퍼 글자, 1px 하드 보더, radius 0), "오늘 복습 N" 버튼(기한 단어 있으면 스틸 채움), 무작위 토글(활성 = 잉크 채움)
- 보기 그룹: 열 수 스테퍼(1–5), 표시 개수 스테퍼(1–15), 밝기 토글(`moon`/`sun`), 보기 설정(`sliders-horizontal`)
- 오른쪽: 화면 전환(PC/모바일), 편집 모드 토글(활성 = 잉크 채움)

**보기 드로어** (설정 아이콘 토글) — `border:1px solid var(--rule); padding:16px 20px; display:flex; gap:30px; flex-wrap:wrap`, `animation:riseIn .18s ease-out`. 글자 크기(12–22), 예문 표시/숨김, 필터(전체 · 미암기만 · 중요만), 오른쪽에 진행률 초기화.

**피드 헤더** — 분류/검색 제목 21px/600, 범위 라벨 `1–6 / 15`(Barlow Condensed 13px, muted), 편집 모드에서는 `N / 15개 편집 중` + 되돌리기 버튼, 오른쪽에 밑줄형 검색 입력(폭 210px, `border-bottom:1px solid var(--rule-strong)`).

**단어 카드(지면의 단)** — `grid-template-columns:repeat(cols,minmax(0,1fr))`, 카드 사이 경계는 `border-right/bottom:1px solid var(--rule-soft)`, 상단은 `1px solid var(--rule)`. 카드 자체는 상자가 아니라 단입니다(라운드·그림자·면 채움 없음).
- 패딩 `18px 20px 22px 18px`, `min-height:250px`
- 암기 카드: 배경 `color-mix(in srgb, var(--color-accent) 8%, transparent)` + 표제어 앞 9px 스틸 사각
- 선택 카드: `box-shadow: inset 0 0 0 1px var(--steel)`
- 표제어 26px/600, `letter-spacing:-0.02em`, `word-break:keep-all; white-space:nowrap`
- 중요 카드: 표제어에 `box-shadow: inset 0 -12px 0 var(--color-accent-300)`(다크는 accent-400 55%), 북마크 아이콘 잉크색
- 뜻 줄: 번호(Barlow Condensed 14px) + 뜻(본문 크기 = 설정값, 기본 15px, `line-height:1.6`, `word-break:keep-all`) + 예문(13.5px, muted). 클릭 시 체크 → 취소선 + muted, **모든 뜻이 체크되면 자동으로 암기 처리**
- 카드 하단: 분류 라벨(Barlow Condensed 11px, uppercase) + 오른쪽에 복습 단계 점 6칸(7px 사각, 채움 = 진행 단계)

**푸터** — 키보드 힌트(Space 암기 · Enter 중요 · ←→ 이동)와 페이지네이션(현재 페이지 = 잉크 채움).

**진행률 패널** (폭 268px, `border-left:1px solid var(--rule); padding-left:24px; position:sticky; top:30px`)
- 제목 "진행률"(Barlow Condensed 11.5px, uppercase, letter-spacing .1em)
- 큰 숫자 62px/600 `line-height:.85` + `%` 20px + 오른쪽 `4 / 15 단어`
- **암기 막대**: 20칸 `grid-template-columns:repeat(20,1fr); gap:3px`, 칸 높이 26px. 채운 칸 수 = `floor(암기비율% / 5)`
- **중요 스트립**: 라벨 "중요" + 20칸, 칸 높이 10px, 채움 없이 `inset 0 0 0 1px var(--ink)`(빈 칸은 `--fill` 외곽선), 오른쪽에 `%`
- 범례: 암기 N(스틸 채움) · 중요 N(잉크 외곽선) · 미암기 N(연한 채움)
- **복습 예정 · 7일**: 7개 막대(오늘, +1…+6), 높이 = `6 + (n/peak)*42`px, 값 0이면 연한 채움
- 분류 목록: 행 클릭 → 그 분류로 필터 + 펼침. 펼치면 `미암기 N` · `중요 N` · `전체 N` 칩(칩 클릭 = 그 조건으로 필터)

### 2. 편집 모드
피드 대신 편집 표. `grid-template-columns:120px 190px minmax(0,1fr)`, 행 `padding:12px 0; border-bottom:1px solid var(--rule-soft)`.
- 분류·표제어 인라인 입력(포커스 시 밑줄만 스틸로), 표제어 옆 단어 삭제(`trash-2`)
- **뜻은 전부 전시**: 각 뜻에 그립(`grip-vertical`, `cursor:grab`) + 번호 + 뜻 입력 + 예문 입력 + 뜻 삭제(`minus`). 그립을 끌어 순서 변경(드롭 지점에 1px 스틸 선, 드래그 중 opacity .4) — 번호 재부여와 체크 상태도 함께 이동
- 행 끝에 점선 버튼 "뜻 추가", 표 아래 스틸 채움 버튼 "단어 추가"
- 헤더의 **되돌리기**: 최대 30단계. 연속 타이핑은 1.2초 단위로 한 단계로 묶음
- 검색·필터가 편집 표에도 적용됨

### 3. 복습 세션 (SRS)
`border:1px solid var(--rule); padding:26px 30px 30px`.
- 헤더: "복습 세션" + `3 / 9` + 큐 진행 스트립(6px 높이, 지나간 칸 = 스틸) + 세션 종료
- 본문: 표제어 44px/600(`letter-spacing:-0.03em`) + 분류 라벨. 처음에는 뜻이 가려지고 점선 버튼 "뜻 보기 (Space)". 공개 후 뜻 18px + 예문 14px
- 하단 액션: 암기함(스틸 채움) · 다시 보기(외곽선) · 중요(북마크) / 오른쪽에 키 힌트
- 완료 화면: `암기함 N · 다시 보기 M — 진행률 P%` + 남은 단어로 다시 / 단어장으로

### 4. 모바일 세로 (390 × 790)
PC 시스템 바는 나오지 않습니다(프레임 위에 미리보기용 전환 줄만).
- 상단 바: "단어장" 17px + `N WORDS` + 진행률 숫자 22px + 메뉴(`menu`)
- 진행률 20칸 띠(높이 14px) + 중요 20칸 띠(높이 6px)
- 검색 줄 + 범위 라벨
- 단일 열 피드: 표제어 23px, 앞머리 11px 사각 = 암기 토글(터치 영역 34×44px, 채움 = 암기 / 1px 외곽선 = 미암기), 오른쪽 북마크 44×44px. 뜻 줄 최소 높이 36px
- 하단 바: 모드 세그먼트(터치 높이 40px) + 페이지 이동 44×40px
- 드로어(바텀 시트): 필터 · 무작위 · 밝기 · 오늘 복습 · 분류 진행률 · CSV 열기/내보내기. 배경 `color-mix(in srgb, var(--ink) 45%, transparent)`, `animation:riseIn .2s ease-out`

## Interactions & Behavior
- **뜻 클릭** = 체크 토글(취소선). 전부 체크 → 암기 자동 ON. 암기 토글 시 그 단어의 체크는 모두 그 값으로 맞춤
- **북마크** = 중요 토글(암기와 독립)
- **키보드**(입력 필드·편집 모드 제외): Space 암기, Enter 중요, ←→ 단어 이동(페이지 자동 전환). 세션 중에는 Space 뜻 보기, Enter 암기함, → 다시 보기
- **모드**: 암기(전부 표시) / 의미(뜻 가림 → "뜻 보기") / 단어(표제어 가림 → "단어 보기"). 모드 전환 시 공개 상태 초기화
- **무작위**: 위 Overview 3번. 표시 순서만 섞이며 진행률 칸·분류 목록·원본 배열은 불변
- **검색**: 표제어 또는 뜻 부분 일치, 입력 시 1페이지로
- **필터**: 전체 / 미암기만 / 중요만 (분류 필터와 조합)
- **CSV 열기**: `category,word,meaning,example` 파싱. 헤더 없어도 동작(위치 기준), `"` 이스케이프 지원, **같은 (분류, 표제어)는 한 단어의 여러 뜻으로 합침**
- **CSV 내보내기**: `category,word,meaning,example,memorized,important` + BOM(`\uFEFF`), 파일명 `vocab.csv`
- **SRS**: 암기함 → `stage = min(6, stage+1)`, `due = now + [1,2,4,8,16,32][stage-1]일`. 다시 보기 → `stage = 0`, `due = now`. 세션 큐 = `due <= now`인 단어를 due 오름차순, 없으면 미암기 단어
- 애니메이션은 `riseIn`(opacity 0→1, translateY 6px→0) 하나만. 드로어·시트·토스트에 사용
- 포커스: `:focus-visible { outline:2px solid var(--color-accent); outline-offset:2px }`

## State Management
```
words:      [{ id, cat, word, meanings: [{ text, example }] }]
prog:       { [id]: { memorized, important, checked: bool[], stage: 0..6, due: epochMs } }
view:       mode('memorize'|'meaning-test'|'word-test'), cols, count, page, fontSize,
            dark, examples, query, filter('전체'|'미암기만'|'중요만'), cat, selected, revealed{}
random:     random(bool), shuffleOrder(id[]|null), preRandom({selected,page}|null)
edit:       editMode, history(최대 30개 {words,prog} 스냅샷), drag 상태
session:    { queue:id[], i, revealed, known, again, finished } | null
device:     'pc'|'mobile' + desktopCols / desktopCount (모바일 강제값은 저장하지 않음)
```
- 영속화: `localStorage['vocabProto.v1']` = `{ schema:2, words, prog, mode, cols(=desktopCols), count(=desktopCount), fontSize, dark, examples }`, 400ms 디바운스
- **마이그레이션 필수**: 로드 시 `prog` 각 항목에 없는 필드를 백필 — `checked`(뜻 수만큼 false), `stage`(암기면 2, 아니면 0), `due`(stage>0이면 오늘+간격, 아니면 오늘 자정). 스키마 버전 키로 이후 필드 추가에도 같은 백필을 돌릴 것
- 되돌리기: 편집 계열 변경(단어/뜻 수정·추가·삭제·순서 변경) 전에만 스냅샷 push, 학습 진행(암기·중요·체크)은 히스토리에 넣지 않음

## Design Tokens
Industry 디자인 시스템 (`_ds/industry-.../styles.css`) 토큰을 그대로 사용합니다. 프로토타입은 런타임에 아래 별칭 변수로 라이트/다크를 전환합니다.

| 별칭 | 라이트 | 다크 |
| --- | --- | --- |
| `--paper` | `var(--color-bg)` `#f2f2f3` | `var(--color-neutral-900)` |
| `--ink` | `var(--color-text)` `#1d1f20` | `var(--color-neutral-100)` |
| `--steel` | `var(--color-accent)` `#5980a6` | `var(--color-accent-400)` |
| `--steel-txt` | `var(--color-accent-700)` | `var(--color-accent-400)` |
| `--rule` | `ink 22%` | `neutral-100 24%` |
| `--rule-soft` | `ink 12%` | `neutral-100 13%` |
| `--rule-strong` | `ink 35%` | `neutral-100 38%` |
| `--muted` | `var(--color-neutral-700)` | `var(--color-neutral-400)` |
| `--muted-2` | `var(--color-neutral-500)` | `var(--color-neutral-500)` |
| `--fill` | `ink 12%` | `neutral-100 15%` |
| 암기 카드 배경 | `accent 8%` | `accent-400 12%` |
| 중요 밑줄 | `var(--color-accent-300)` | `accent-400 55%` |

- 타이포: 본문·표제어 `IBM Plex Sans KR`(한글), 숫자·라벨 `Barlow Condensed`(= `var(--font-heading)`). 크기: 표제어 26px(세션 44px, 모바일 23px), 본문 12–22px 가변(기본 15px), 라벨 11–13.5px. 라벨은 `letter-spacing:.09~.12em; text-transform:uppercase`
- 간격: 8 / 10 / 12 / 14 / 18 / 20 / 24 / 30 / 34px 위주. 카드 패딩 `18px 20px 22px 18px`
- 반경: **0** (Industry의 사각 문법). 그림자는 카드에 쓰지 않고 토스트·시트에만 `var(--shadow-lg)`
- 아이콘: Lucide 1.5, 크기 13 / 14 / 15 / 16 / 17 / 19px

## Assets
없음. 아이콘은 Lucide CDN(`lucide@0.451.0`), 폰트는 Google Fonts(`IBM Plex Sans KR`) + Industry 시스템의 Barlow / Barlow Condensed. 이미지는 사용하지 않습니다.

## Screenshots
`screenshots/` — 플로토타입 실화면 캡션. 치수는 캡션이 아니라 이 문서를 기준으로 하십시오.
- `01-pc-default.png` — PC 기본 화면(툴바 · 3열 피드 · 진행률 패널)
- `02-edit-mode.png` — 편집 모드(뜻 전진시 · 드래그 그립 · 되돌리기)
- `03-session-hidden.png` — 복습 세션, 뜻 가림 상헜
- `04-session-revealed.png` — 복습 세션, 뜻 공개 후
- `05-mobile.png` — 모바일 세로 390 × 790
- `06-mobile-sheet.png` — 모바일 바텀 시트(보기 · 파일)

## Files
- `단어장 프로토타입.dc.html` — 동작하는 프로토타입(PC · 모바일 · 편집 모드 · 복습 세션 · CSV · 저장). 로직은 파일 하단 `class Component` 안에 있습니다.
- `단어장 디자인 시안.dc.html` — 방향 3안(1a 사전 지면 확정)과 전개 화면(모바일 가로 2열 · 드로어 · 편집 모드 · 고급 검색 · 다크 모드).
- `support.js` — 프로토타입 실행 런타임(제품 코드와 무관, 미리보기 용도).
- `github.md` — 원본 저장소 연결 정보와 화면-파일 매핑.
- 원본 저장소 참고 파일: `index.html`, `app.js`, `store.js`(설정·진행률 스키마), `csv.js`, `style.css`, `sample.csv`.

## 개발자에게 전달할 요약 (Claude Code 프롬프트로 바로 사용 가능)
> 첨부한 `design_handoff_vocab_app/README.md`와 `단어장 프로토타입.dc.html`은 단어장 앱의 하이파이 디자인 레퍼런스다. 지금 코드베이스(정적 HTML + app.js/store.js/csv.js + localStorage)의 패턴을 유지하면서 README의 화면·상호작용·상태 모델·토큰을 그대로 구현해라. 특히 (1) 진행률 20칸·칸당 5%·내림, 중요는 별도 스트립, (2) 무작위 토글(표시 순서만, 끄면 원위치 복귀), (3) 편집 모드의 뜻 전체 전시 + 드래그 정렬 + 30단계 되돌리기, (4) SRS 스케줄(1·2·4·8·16·32일)과 `store.js` 진행률 스키마 마이그레이션을 빠뜨리지 마라. HTML 파일을 그대로 복사하지 말고 기존 구조에 맞춰 재구현할 것.
