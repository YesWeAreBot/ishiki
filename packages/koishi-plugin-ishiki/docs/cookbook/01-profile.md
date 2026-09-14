# 01 · Profile

> v1 已确认。一个 profile = 一个主心智。

Profile 用配置文件声明，不进 Koishi Schema，不上配置页。建议路径：`data/ishiki/profiles.yaml`。

身体集合由 `allowedChannels` 的 `sid` 推导，不单独配 `bots`。

```yaml
profiles:
  - id: boki
    dataPath: data/ishiki/boki
    model: deepseek:deepseek-flash
    allowedChannels:
      - sid: onebot:1434974784
        channels:
          - channelA
          - channelB
          - private:*
          - "!private:12345678"
      - sid: qq:4138444372060156334
        channels: []

  - id: other
    dataPath: data/ishiki/other
    model: deepseek:deepseek-flash
    allowedChannels:
      - sid: onebot:1434974784
        channels:
          - private:12345678
```

## allowedChannels

同时是**采集白名单**和**响应白名单**。写进来 = 这个心智在这里运行；可见 = 可以响应。

同一 profile 的同一多方频道不能挂多具 bot。加载期拒绝。可以拆到不同 profile。

## 分发

能确定来源的事件（频道消息、带频道的事件、好友请求、加群等）**恰好进一个 profile**。

同一 `sid` 可以出现在多个 profile 里，但它们的 `allowedChannels` **不准重叠**。加载期拒绝。

登录 / 账号状态变更没有频道归属，发给所有接管该 `sid` 的 profile。
