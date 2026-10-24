# 宠物屋素材与规则来源 · 署名

本目录下的 4 个 webp，以及 `modules/pet-nest.js` 里的宠物养成规则，
均移植自开源项目 **Cove 灵宠屋**：

- 仓库：https://github.com/moonlin1213/cove-pet-nest
- 版本：v0.2.0
- 许可：MIT License
- 版权声明：Copyright (c) 2026 death34018-hue

## 原始 MIT 许可全文

```
MIT License

Copyright (c) 2026 death34018-hue

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 上游 NOTICE（署名）

> The pet-care economics, visible-conversation contribution policy and fantasy-pet
> concept are adapted from Cove. The upstream MIT copyright notice is preserved in LICENSE.
>
> This independent implementation contains no upstream runtime databases, conversations,
> credentials, private relationships or individualized pet images. The four bundled
> starter images are generic shared UI artwork directed for Cove, selected individually
> for this distribution. Their checksums and source category are recorded in
> `src/cove_pet_nest/assets/manifest.json`. No personal pet assets or source repository
> history are included.
>
> No third-party fonts are bundled. Python and browser dependencies retain their own licenses.

## 本目录素材清单（与上游 manifest.json 校验一致）

| 文件 | SHA-256 | 来源类别 | 许可 |
|---|---|---|---|
| room-light.webp | 91a3e480f1b27ab7df4980a21d0c16c6d0d5a234e9c810d62f5b7d61c99ce98b | Cove generic shared starter artwork | MIT（by the directing owner） |
| cat-sprites-light.webp | 6fc2808f484f7ca1bdffabb34c9f58f7a784c4c58fe6eb4b00b22b819348f6de | Cove generic shared starter artwork | MIT（by the directing owner） |
| dog-sprites-light.webp | 508be0b2de6522be73c4443f2cbd110baf811329595600824335854272d4a476 | Cove generic shared starter artwork | MIT（by the directing owner） |
| egg-sprites-light.webp | 7df57e98c547889c9fba6ddcab0bb073775ee3e3ce53ee1b8552e0a4ddd2ba2f | Cove generic shared starter artwork | MIT（by the directing owner） |

三张 sprites 图是 1152×768 的 **3×2 六格透明图集**（每格 384×384），
六个格子是同一只宠物的六个情绪/动作姿态（睁眼 / 闭眼 / 睡趴 / 低头吃碗 / 趴着抬头 / 伸爪），
不是成长阶段。room-light.webp 是 1024×1536 的房间插画。

## 与上游的有意差异

上游把「阶段推进」绑在图片服务上（只有新样貌生成成功，宠物才会长大），
没有生图服务时宠物永远停在第 0 阶段。
本移植把两件事拆开：阶段推进 = 成长值 + 相处天数达标（纯计算），
生图只是可选的「换新模样」，没有它也照样长大。

其余规则（粮食曲线、饱腹衰减、性格哈希、孵化维度、关系信号上限）按上游源码逐条移植，
数值口径一致。
