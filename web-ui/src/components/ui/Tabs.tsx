import { useState } from 'react';
import {
  TabList,
  Tab as FluentTab,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';
import type { SelectTabEventHandler } from '@fluentui/react-components';

export interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  onChange?: (tabId: string) => void;
}

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
  },
  tabList: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    marginBottom: '16px',
  },
  tab: {
    color: tokens.colorNeutralForeground2,
    fontSize: '14px',
    fontWeight: 500,
    padding: '12px 16px',
    ':hover': {
      color: tokens.colorNeutralForeground1,
    },
    '&[aria-selected="true"]': {
      color: tokens.colorBrandForeground1,
    },
  },
  content: {
    minHeight: '100px',
  },
});

export function Tabs({ tabs, defaultTab, onChange }: TabsProps) {
  const styles = useStyles();
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id);

  const handleTabChange: SelectTabEventHandler = (_, data) => {
    const tabId = data.value as string;
    setActiveTab(tabId);
    onChange?.(tabId);
  };

  const activeContent = tabs.find((tab) => tab.id === activeTab)?.content;

  return (
    <div className={styles.container}>
      <TabList
        className={styles.tabList}
        selectedValue={activeTab}
        onTabSelect={handleTabChange}
      >
        {tabs.map((tab) => (
          <FluentTab
            key={tab.id}
            value={tab.id}
            className={styles.tab}
          >
            {tab.label}
          </FluentTab>
        ))}
      </TabList>
      <div className={styles.content} role="tabpanel">
        {activeContent}
      </div>
    </div>
  );
}
