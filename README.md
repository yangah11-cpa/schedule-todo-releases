# 일정 & 할일

일정관리(구글 캘린더 연동, 한국 음력 연간 반복)와 할 일(기한 없음·반복·하위 할 일)을 한 화면에서 관리하는 Windows 프로그램입니다.

- 설치: [Releases](../../releases/latest)에서 `ScheduleTodo-Setup-x.y.z.exe`를 내려받아 실행
- 업데이트: 설치된 프로그램이 이 저장소의 최신 릴리스를 확인해 자동으로 업데이트합니다.

## 개발

```
npm ci
npm start          # 개발 실행
npm run dist       # 로컬에서 설치 파일 빌드
```

새 버전 게시: `package.json`의 `version`을 올려 main에 push하면
GitHub Actions가 설치 파일을 빌드해 릴리스로 게시합니다.

Google 캘린더 연동에 필요한 OAuth 클라이언트 ID/비밀번호와 로그인 정보는 코드에 포함되지 않으며,
각 PC의 설정 화면에서 입력되어 그 PC에만 암호화 저장됩니다.
