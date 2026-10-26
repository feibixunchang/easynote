; ============ Windows 安装器自定义（简易笔记）============
; 背景：electron-builder 默认只做"优雅关闭"（taskkill 不带 /F）；
; 而本应用在 Windows 上点 ✕ 是「最小化到托盘」，进程不会退出，
; 于是安装器关不掉它，弹出「简易笔记无法关闭，请手动关闭它，然后单击重试以继续」，
; 用户只能去任务管理器结束进程。
;
; 可用钩子（electron-builder 模板里真实存在的）：
;   customInit    —— 插入在安装程序 .onInit 里，**早于**安装段的应用运行检查
;   customUnInit  —— 卸载程序 .onInit
; 所以这里在 customInit 里直接强制结束进程（taskkill /F /T），后面就不会再弹那个提示。
; 安装前本来就要退出应用，属预期行为；perMachine=false（按用户安装）下结束自己的进程无需管理员权限。

!macro customInit
  DetailPrint "Stopping running ${PRODUCT_NAME} ..."
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  Pop $0
  Sleep 700
  ; Electron 是多进程，再补一次清掉残留（GPU / 渲染进程）
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  Pop $0
  Sleep 300
!macroend

!macro customUnInit
  DetailPrint "Stopping running ${PRODUCT_NAME} ..."
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  Pop $0
  Sleep 700
!macroend
