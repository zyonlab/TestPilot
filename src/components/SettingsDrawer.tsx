import { Drawer } from "@/components/overlay";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { SectionPage } from "@/components/SectionNav";
import { ProjectsPage } from "@/pages/Projects";
import { ChainConfigPage } from "@/pages/ChainConfig";
import { DangerSection, EnvSection, PrefsSection } from "@/pages/SettingsSections";
import { ModelProfilesSection } from "@/pages/ModelProfiles";

/**
 * 设置：一个抽屉，不是一扇门。
 *
 * 这里的每一件事都**跨一次工作存在**，而且改动频率以周计——目标端、密钥、模型端点、
 * 提示词模板。把它们放在导航的第一层，等于让每天要看的东西和每月改一次的东西争同一块地方。
 *
 * 分节的依据是「谁会来改它、改一次影响谁」：环境属于项目，提示词模板属于 harness（改它会进
 * 指纹、影响每一次后续运行），语言与调试属于这个人，端点与进程属于运行时。
 *
 * 2026-09-09：按双入口双模型决策恢复项目模型设置。
 * 项目、环境、模型与 review 留在 TestPilot；自进化评估由 Penguin UI 承担。
 */
/**
 * 设置的内容本身，与「它装在抽屉里还是占满一屏」无关。
 *
 * 抽出来的理由是一次真实的回归：左导航落地之后，界面切到任何一屏，画布就不再挂载，
 * 而设置的开关是画布**内部**的 useState、入口只有它工具条右端那个齿轮——
 * 于是站在复核屏上**建不了项目、改不了模型端点、看不到进程**。
 * 「现有功能不允许丢失」是这个仓库写在文档地图里的红线，这一条踩到了。
 */
export function SettingsBody({ compact }: { compact?: boolean }) {
  const t = useT();
  const activeId = useStore((s) => s.activeProjectId);
  const platform = useStore((s) => s.projects.find((p) => p.id === activeId)?.targetPlatform ?? "web");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionPage
        title={t("nav.settings")}
        subtitle={t("settings.subtitle")}
        fallback="projects"
        compact={compact}
        sections={[
          {
            id: "models",
            group: t("settings.groupProject"),
            label: t("modelRoles.title"),
            why: t("modelRoles.help"),
            render: () => <ModelProfilesSection />,
          },
          {
            id: "projects",
            group: t("settings.groupProject"),
            label: t("nav.projects"),
            why: t("settings.whyProjects"),
            render: () => <ProjectsPage />,
          },
          {
            id: "env",
            group: t("settings.groupProject"),
            label: t("settings.env"),
            why: t("settings.whyEnv"),
            render: () => <EnvSection />,
          },
          {
            id: "chain",
            group: t("settings.groupProject"),
            label: t("nav.chain"),
            why: t("settings.whyChain"),
            hidden: platform !== "web",
            render: () => <ChainConfigPage />,
          },
          {
            id: "danger",
            group: t("settings.groupProject"),
            label: t("settings.danger"),
            why: t("settings.whyDanger"),
            render: () => <DangerSection />,
          },
          {
            id: "prefs",
            /* 不给组标题：`nav.ts` 刚用「两项的组几乎不减少扫描，却各占一行标题」
               这条理由把导航从四组并成三组，而这里是一个**一项**的组。
               它确实和上面四项不是一类（那四项是这个项目的，这一项是你自己的——
               harness 那几项 v3 之后已经不在这里了），
               所以留一条分隔线，不留一行标题。 */
            standalone: true,
            label: t("settings.prefs"),
            why: t("settings.whyPrefs"),
            render: () => <PrefsSection />,
          },
        ]}
      />
    </div>
  );
}

/** 抽屉形态：从画布的齿轮打开时用它。内容与整屏那一份是同一个组件。 */
export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Drawer open onClose={onClose} title={t("nav.settings")} resizeKey="settings" defaultWidth={920}>
      <SettingsBody compact />
    </Drawer>
  );
}
