import { Drawer } from "@/components/overlay";
import { InSectionProvider } from "@/components/SectionNav";
import { surfaceById, surfacesInGroup } from "@/lib/surfaces";

/**
 * 打开的物料卡，作为一个抽屉。
 *
 * 全部浮层走同一个原语：右侧滑出、左缘可拖宽、Esc 关闭、点背景关闭。此前这里是一张浮在画布上的
 * 卡片、设置是另一套自己写的抽屉——两种关闭方式、两种宽度行为，读者要为每一种浮层各学一遍。
 *
 * 宽度由读者决定并被记住：这里装的是规格全文、用例表和代码 diff，什么宽度合适取决于里面是什么，
 * 而不是取决于写这个组件时哪个数看着顺眼。
 *
 * 同组的界面在标题旁以 tab 并列，因为它们是同一个对象的不同镜头：看板、复核队列、追溯问的都是
 * 「这批用例怎么样」。
 */
export function SurfacePanel({
  surfaceId,
  wfRunId,
  onClose,
  onSwitch,
}: {
  surfaceId: string;
  /** 画布上正在看的运行——从它的产物卡点进来的界面应当停在它上面。 */
  wfRunId?: string;
  onClose: () => void;
  onSwitch: (id: string) => void;
}) {
  const surface = surfaceById(surfaceId);
  if (!surface) return null;
  const siblings = surfacesInGroup(surface.group);

  return (
    <Drawer
      open
      onClose={onClose}
      resizeKey={`surface:${surface.group}`}
      defaultWidth={980}
      tabs={siblings.map((s) => ({
        id: s.id,
        label: s.title,
        active: s.id === surface.id,
        onSelect: () => onSwitch(s.id),
      }))}
    >
      {/* The hosted pages each render their own TopBar; inside a drawer that would be a
          second header. The same flag the section shell used tells them to stand down. */}
      <InSectionProvider>{surface.render({ wfRunId })}</InSectionProvider>
    </Drawer>
  );
}
