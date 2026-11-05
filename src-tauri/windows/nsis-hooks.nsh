; 安装/卸载后刷新 Explorer 图标缓存。
; Windows 会按路径缓存快捷方式图标，覆盖安装后常继续显示旧图标；
; 这里通知 Shell 重新读图标，避免用户看到旧的黑底图标直到手动清缓存。
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'ie4uinit.exe -show'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::ExecToLog 'ie4uinit.exe -show'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
