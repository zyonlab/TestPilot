import { Drawer } from "@/components/overlay";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { SectionPage } from "@/components/SectionNav";
import { ProjectsPage } from "@/pages/Projects";
import { ModelConfigPage } from "@/pages/ModelConfig";
import { ChainConfigPage } from "@/pages/ChainConfig";
import { ProcessesPage } from "@/pages/Processes";
import { CapabilitiesPage } from "@/pages/Capabilities";
import { DangerSection, EnvSection, PrefsSection, PromptsSection } from "@/pages/SettingsSections";

/**
 * 设置：一个抽屉，不是一扇门。
 *
 * 这里的每一件事都**跨一次工作存在**，而且改动频率以周计——目标端、密钥、模型端点、
 * 提示词模板。把它们放在导航的第一层，等于让每天要看的东西和每月改一次的东西争同一块地方。
 *
 * 分节的依据是「谁会来改它、改一次影响谁」：环境属于项目，提示词模板属于 harness（改它会进
 * 指纹、影响每一次后续运行），语言与调试属于这个人，端点与进程属于运行时。
 */
export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const t = useT();
  const activeId = useStore((s) => s.activeProjectId);
  const platform = useStore((s) => s.projects.find((p) => p.id === activeId)?.targetPlatform ?? "web");

  return (
    <Drawer open onClose={onClose} title={t("nav.settings")} resizeKey="settings" defaultWidth={920}>
      <div className="flex min-h-0 flex-1 flex-col">
        <SectionPage
            title={t("nav.settings")}
            subtitle={t("settings.subtitle")}
            fallback="projects"
            compact
            sections={[
              { id: "projects", group: t("settings.groupProject"), label: t("nav.projects"), why: t("settings.whyProjects"), render: () => <ProjectsPage /> },
              { id: "env", group: t("settings.groupProject"), label: t("settings.env"), why: t("settings.whyEnv"), render: () => <EnvSection /> },
              { id: "chain", group: t("settings.groupProject"), label: t("nav.chain"), why: t("settings.whyChain"), hidden: platform !== "web", render: () => <ChainConfigPage /> },
              { id: "danger", group: t("settings.groupProject"), label: t("settings.danger"), why: t("settings.whyDanger"), render: () => <DangerSection /> },
              { id: "model", group: t("settings.groupModel"), label: t("settings.endpoint"), why: t("settings.whyModel"), render: () => <ModelConfigPage /> },
              { id: "prompts", group: t("settings.groupModel"), label: t("settings.prompts"), why: t("settings.whyPrompts"), render: () => <PromptsSection /> },
              { id: "processes", group: t("settings.groupRuntime"), label: t("nav.processes"), why: t("settings.whyProcesses"), render: () => <ProcessesPage /> },
              { id: "capabilities", group: t("settings.groupRuntime"), label: t("nav.capabilities"), why: t("settings.whyCapabilities"), render: () => <CapabilitiesPage /> },
              { id: "prefs", group: t("settings.groupPrefs"), label: t("settings.prefs"), why: t("settings.whyPrefs"), render: () => <PrefsSection /> },
            ]}
        />
      </div>
    </Drawer>
  );
}
