; 기본 CHECK_APP_RUNNING의 강제 종료 대신 사용자에게 Otter의 정상 종료를 요청한다.
; nsProcess는 이름으로 조회하므로 다른 Otter 설치도 보수적으로 차단할 수 있다.
!macro customCheckAppRunning
  Push $R0
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ; 603만 조회 성공/프로세스 부재다. 실행 중(0)과 조회 오류는 모두 중단한다.
  ${If} $R0 != 603
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Otter가 실행 중이거나 종료 여부를 확인할 수 없습니다.$\r$\n트레이의 'Otter 완전 종료'를 선택하고 작업 정리가 끝난 뒤 설치 또는 제거를 다시 실행하세요.$\r$\n설치 관리자는 실행 중인 작업을 강제 종료하지 않습니다." /SD IDOK
    ${EndIf}
    SetErrorLevel 1618
    Quit
  ${EndIf}
  Pop $R0
!macroend
