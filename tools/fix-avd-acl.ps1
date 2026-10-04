# 修 AVD 目录写权限并拉起常驻模拟器
# 背景：D:\手机记账app\.android-env\avd-home 及其子树缺少登录用户的完全控制权，
#      导致 emulator 冷启动无法创建 snapshot.lock.lock（error 5），卡在 11MB 永不 boot。
#      工作区根目录有 CUI\13621:(F) 所以能写，AVD 目录没有。

$root = 'D:\手机记账app'
$target = Join-Path $root '.android-env\avd-home'
$me = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME

Write-Output "=== 1) 清理卡死的僵尸模拟器进程 ==="
Get-Process -Name 'qemu-system-x86_64*', 'emulator', 'netsimd' -ErrorAction SilentlyContinue |
    ForEach-Object {
        Write-Output ("  结束 PID={0} MEM={1}MB CPU={2}s" -f $_.Id, [math]::Round($_.WorkingSet64 / 1MB), [math]::Round($_.CPU, 1))
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Seconds 4
$left = (Get-Process -Name 'qemu-system-x86_64*', 'emulator', 'netsimd' -ErrorAction SilentlyContinue).Count
Write-Output "  剩余进程: $left"

Write-Output "=== 2) 给登录用户补 AVD 目录完全控制权 ==="
Write-Output "  授权对象: $me"
Write-Output "  目标目录: $target"
$grantArg = '{0}:(OI)(CI)F' -f $me
& icacls.exe $target /grant $grantArg /T /C 2>&1 | Select-Object -Last 3

Write-Output "=== 3) 复核 ACL ==="
$acl = & icacls.exe $target 2>&1
$acl | Where-Object { $_ -match '13621|CUI|Successfully' }
$sub = & icacls.exe (Join-Path $target 'jizhang_test.avd') 2>&1
$sub | Where-Object { $_ -match '13621|CUI|Successfully' }

Write-Output "=== 4) 实测写权限 ==="
$probe = Join-Path $target '.write-probe.tmp'
try {
    Set-Content -Path $probe -Value 'ok' -ErrorAction Stop
    Write-Output '  写入成功'
    Remove-Item $probe -Force
} catch {
    Write-Output ("  写入失败: {0}" -f $_.Exception.Message)
}
$probe2 = Join-Path $target 'jizhang_test.avd\snapshot.lock.lock'
try {
    Set-Content -Path $probe2 -Value '' -ErrorAction Stop
    Write-Output '  AVD 子目录可创建 snapshot.lock.lock（模拟器启动必需）'
    Remove-Item $probe2 -Force
} catch {
    Write-Output ("  AVD 子目录写入失败: {0}" -f $_.Exception.Message)
}
