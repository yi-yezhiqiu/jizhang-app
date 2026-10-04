# 签名密钥（本目录已被 .gitignore 排除，不会上传）

## 为什么这里什么都没有

`keys/debug.keystore` 是 App 的**签名身份**，已刻意排除在版本控制之外：

- **丢失**：以后无法再为已安装的 App 发布更新。只能卸载重装，记账数据会一起丢。
- **泄露**：别人可以伪造一个同包名的"升级包"覆盖安装到你的手机上。

所以它必须**单独离线备份**（比如复制到网盘或另一台机器），不要放在仓库里。

## 怎么重新生成

如果换了机器，或密钥丢了，执行构建脚本会自动生成一个新的：

```
tools\build.cmd
```

脚本检测到 `keys\debug.keystore` 不存在时会调用 `keytool` 生成：

```
keytool -genkeypair -keystore keys\debug.keystore -alias jizhangkey \
        -keyalg RSA -keysize 2048 -validity 10950 \
        -storepass jizhang123 -keypass jizhang123 \
        -dname "CN=JiZhang Debug, OU=Dev, O=Personal, L=CN, ST=CN, C=CN"
```

> 注意：debug 密钥的口令是公开的固定值（`jizhang123`），这在**自己侧载使用**的场景下没问题
> （Android 本来也是这个思路）。但**不要用它上架应用商店**——上架需要单独生成 release 密钥，
> 并把口令放在不提交的地方。

## 如果你要发布给别人用

1. 另生成一份 release 密钥（换个别名与强口令），同样不要提交进仓库；
2. 在 `tools/build.cmd` 里把它做成可通过参数指定，而不是写死；
3. 永久备份该密钥——**丢了就再也无法为同一个 App 发布更新**。
