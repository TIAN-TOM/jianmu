// 时间轨：视频时长摆成一条线，同时画章节、重点、生成进度和播放位置。侧边栏竖着用，卡片横着用。
// 点一段跳到这一章开头，只是给鼠标的捷径；同样的信息都在章节列表里，所以整条轨道不进读屏、不进 Tab 顺序。
import { formatTimestamp } from "../../../core/transcript/segment.ts";
import { percent, railLayout, type RailInput, type RailPiece } from "./rail.ts";

export interface TimeRailProps extends RailInput {
  readonly orientation?: "vertical" | "horizontal";
  readonly onSeek?: (startSec: number) => void;
  /** 悬停到某一章（按章节序号），离开时是 null；章节列表据此高亮同一章。 */
  readonly onHover?: (index: number | null) => void;
}

const tipOf = (piece: RailPiece): string | undefined => (piece.kind === "chapter" ? `${piece.title} ${formatTimestamp(piece.startSec)}` : undefined);

export function TimeRail({ orientation = "vertical", onSeek, onHover, ...input }: TimeRailProps) {
  const { pieces, playhead } = railLayout(input);
  return (
    <div class="rail" data-orientation={orientation} aria-hidden="true" onMouseLeave={onHover ? () => onHover(null) : undefined}>
      <span class="rail-line" />
      {pieces.map((piece) => (
        <span
          key={`${piece.kind}-${piece.index}`}
          class="rail-piece"
          data-kind={piece.kind}
          data-index={piece.index}
          data-key={piece.key ? "true" : undefined}
          data-focus={piece.focus ? "true" : undefined}
          title={tipOf(piece)}
          style={{ "--start": percent(piece.start), "--size": percent(piece.size), "--played": percent(piece.played) }}
          onClick={piece.kind === "chapter" && onSeek ? () => onSeek(piece.startSec) : undefined}
          onMouseEnter={piece.kind === "chapter" && onHover ? () => onHover(piece.index) : undefined}
        >
          <i class="rail-played" />
        </span>
      ))}
      {playhead === null ? null : <span class="rail-head" style={{ "--at": percent(playhead) }} />}
    </div>
  );
}
