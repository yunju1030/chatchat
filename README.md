# ChatChat

HTML, CSS, JavaScript와 Node.js / Express로 만든 간단한 AI 챗봇입니다. OpenAI Chat Completions API의 `gpt-4o-mini` 모델을 사용합니다. 데이터베이스나 별도 프런트엔드 빌드가 필요하지 않습니다.

## 로컬 실행

Node.js 22를 설치한 다음 프로젝트 폴더에서 실행합니다.

```powershell
npm install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

`.env`에 본인의 OpenAI API 키를 입력하세요.

```dotenv
OPENAI_API_KEY=본인의_API_키
PORT=3000
```

```powershell
npm run dev
```

브라우저에서 http://localhost:3000 을 엽니다. 일반 실행은 `npm start`입니다. API 키는 서버 환경변수로만 사용하며 브라우저에 전달하지 않습니다. `.env`는 Git에 커밋하지 않습니다.

## Vercel 배포

1. 이 프로젝트를 Git 저장소에 올리고 Vercel에서 Import합니다.
2. 프로젝트 루트를 Root Directory로 지정하고 Framework Preset을 **Express**로 설정합니다. `vercel.json`에도 Express를 지정했습니다. 별도의 Build Command나 Output Directory 설정은 필요하지 않습니다.
3. Vercel 프로젝트의 Settings → Environment Variables에 `OPENAI_API_KEY`를 추가합니다. 사용할 Production / Preview 환경에 적용하세요.
4. Deploy합니다. 환경변수를 나중에 변경했다면 다시 배포하세요.

CLI를 사용한다면 프로젝트 폴더에서 `npx vercel`로 프로젝트를 연결하고, `npx vercel env add OPENAI_API_KEY production`으로 키를 추가한 후 `npx vercel --prod`로 배포할 수 있습니다.

Vercel은 루트 `index.js`의 기본 export를 Express 진입점으로 사용하고 `public/` 파일은 CDN으로 제공합니다. 실제 Vercel 배포와 OpenAI API 호출에는 본인의 계정과 키가 필요합니다.

## 대화 기록

- 브라우저 탭의 `sessionStorage`에 화면의 대화 기록과 별도의 API용 최근 기록, 규칙, 오래된 기록의 요약을 함께 저장합니다. 같은 탭의 새로고침 후에는 복원되고 **새 대화** 버튼으로 모든 상태를 초기화합니다. 기존 v1 기록도 자동으로 불러옵니다. 저장 공간을 초과하면 현재 탭의 메모리로 동작하며 안내를 표시합니다.
- 요청마다 이전 user / assistant 메시지와 새 질문, 대화 기억을 서버에 전달합니다. 서버 인스턴스 메모리나 DB에 대화를 저장하지 않으므로 Vercel 서버리스 환경에서도 맥락을 전달합니다.
- 서버가 직접 system 메시지를 추가하고 지정 모델로 OpenAI를 호출합니다. 클라이언트가 임의의 system 역할을 전달할 수 없습니다.
- 입력과 답변은 메시지당 8,000자, 요청 대화는 총 60,000자까지입니다. API용 최근 기록이 새 질문 포함 21개 메시지 또는 16,000자를 넘으면 오래된 완결 턴을 요약하고 최근 최대 13개 메시지를 남깁니다. 글자 수 예산 때문에 더 줄일 수도 있습니다. API 응답에 표시된 최근 기록만 다음 요청에 전달해 압축된 원문을 반복 전송하지 않습니다. 화면의 과거 대화는 그대로 읽을 수 있습니다. 이는 컨텍스트 한계에 도달하기 전 적용하는 비용 예산이며 정확한 토큰 계산은 아닙니다.
- 답변과 기억은 GPT-4o mini의 Structured Outputs로 한 번에 받습니다. 별도 규칙 추출/요약 API를 매 턴 호출하지 않습니다. 규칙은 주제별 key로 관리하고 최신 수정/취소를 반영합니다. 요약은 최대 2,000자, 규칙은 최대 16개이며 일반적인 자연어 규칙의 해석과 요약에는 모델의 오류 가능성이 있습니다.
- 끝말잇기는 한국어 단어 하나, 지정한 글자 수, 사용자가 마지막으로 낸 단어와의 연결을 서버에서 검사합니다. 엄격한 연결을 사용하므로 두음법칙은 적용하지 않습니다. 일반 답변도 정확한 글자/단어 수 및 최소/최대 길이를 검사합니다. 예: `끝말잇기는 반드시 세 글자 단어로만 하자`, `이제 두 글자 단어로 바꾸자`, `글자 수 제한은 취소하자`, `끝말잇기는 그만하자`, `앞으로 답변은 100자 이내로 해줘`.
- 글자는 Unicode NFC 정규화 및 grapheme 단위로 세며 내부 공백과 문장부호를 포함합니다. 단어 수는 공백 기준입니다. 명확한 한국어 길이 명령은 서버에서도 보강하고 일반 규칙은 모델이 해석합니다. 실제 사전 단어 여부/뜻의 정확성까지 보장하는 검사는 아닙니다.
- 규칙 위반 시 기억을 고정한 상태에서 최대 두 번 추가 생성하며 다시 위반하면 오류를 반환합니다. 요청 전체의 제한 시간은 50초입니다. 실패한 턴은 기록/기억에 반영하지 않고 입력을 복원합니다. 어려운 조건이나 모순된 조건은 실패할 수 있습니다.
- 메시지는 화면에 텍스트로 표시해 사용자 입력이나 모델 답변의 HTML이 실행되지 않도록 합니다.
- 응답 대기 표시, 중복 전송 방지, 한국어 IME 입력, 오류 시 입력 복원, 모바일 레이아웃을 지원합니다.
- 화면은 뷰포트 높이에 맞춰 고정됩니다. 헤더/모델 표시/입력창을 유지하고 가운데 대화 영역만 스크롤합니다. 아래쪽을 보고 있을 때 새 메시지를 따라가고, 이전 대화를 읽는 동안에는 위치를 유지합니다. 모바일 가상 키보드의 viewport 크기 변화도 반영합니다.
- 대화 내용은 답변 생성을 위해 OpenAI로 전송됩니다. `store: false`는 Chat Completion 저장을 비활성화하는 설정이며 OpenAI의 모든 보관 정책을 해제하는 의미는 아닙니다.

## 검증

```powershell
npm test
```

테스트는 실제 API 키나 비용 없이 OpenAI 응답을 모의 처리합니다. 대화 기록 전달, 모델 지정, 입력 검증, API 키 누락, API 오류와 타임아웃, 요약 및 최근 기록 보존, 규칙 수정/취소, 길이 검사와 재생성을 확인합니다.

Windows에 Chrome이 설치되어 있으면 `node scripts/check-browser.mjs`로 데스크톱/모바일 크기의 레이아웃, 자동 스크롤, 읽던 위치 유지, 기존 저장 기록 이관, 새 대화 초기화를 실제 headless 브라우저에서 확인할 수 있습니다. Chrome 경로가 다르면 `CHROME_PATH` 환경변수에 지정합니다. 이 검증도 OpenAI 응답을 모의 처리합니다. 실제 모바일 키보드와 실시간 OpenAI 응답은 별도로 확인해야 합니다.

수정 후 `npm start`로 실행 중인 서버는 Ctrl+C로 종료한 다음 `npm start`로 다시 실행하세요. `npm run dev`는 서버 파일 변경 시 자동 재시작합니다. 브라우저도 새로고침하세요. Vercel에서는 변경한 소스로 다시 배포해야 합니다. 의존성은 추가하지 않았습니다.

## 파일 구조

```text
index.js           Express 앱과 POST /api/chat
conversation.js    대화 기억 스키마, 압축, 규칙 보강 및 응답 검증
server.js          로컬 서버 실행
public/index.html  채팅 화면
public/style.css   반응형 스타일
public/app.js      채팅 및 탭 대화 기록
test/chat.test.js  API 동작 테스트
test/conversation.test.js  규칙 및 길이 검증 테스트
scripts/check-browser.mjs 실제 브라우저 회귀 검증(모의 API)
.env.example      환경변수 예시
vercel.json       Vercel Express 설정
```

## 참고 문서

- [OpenAI 공식 Chat Completions 문서](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [OpenAI GPT-4o mini 모델 문서](https://developers.openai.com/api/docs/models/gpt-4o-mini)
- [Vercel 공식 Express 배포 문서](https://vercel.com/docs/frameworks/backend/express)

이 예제에는 로그인이나 사용자별 요청 제한이 없습니다. 공개 서비스로 운영하면 누구나 API를 호출해 연결한 OpenAI 계정의 사용량을 소비할 수 있으므로 용도에 맞는 접근 제한을 추가하세요.
