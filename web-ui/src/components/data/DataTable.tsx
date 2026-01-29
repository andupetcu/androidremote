import { useState } from 'react';
import {
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Checkbox,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowUpRegular, ArrowDownRegular } from '@fluentui/react-icons';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  width?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  emptyIcon?: ReactNode;
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  onRowClick?: (row: T) => void;
}

const useStyles = makeStyles({
  wrapper: {
    width: '100%',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '8px',
    overflow: 'hidden',
  },
  headerCell: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    '@media (max-width: 768px)': {
      padding: '8px 10px',
      fontSize: '11px',
    },
  },
  sortableHeader: {
    cursor: 'pointer',
    userSelect: 'none',
    ':hover': {
      color: tokens.colorNeutralForeground1,
    },
  },
  sortIcon: {
    marginLeft: '4px',
    verticalAlign: 'middle',
  },
  row: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    transition: 'background-color 150ms ease',
    ':last-child': {
      borderBottom: 'none',
    },
  },
  rowClickable: {
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  rowSelected: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
  },
  cell: {
    padding: '12px 16px',
    color: tokens.colorNeutralForeground1,
    fontSize: '14px',
    '@media (max-width: 768px)': {
      padding: '8px 10px',
      fontSize: '13px',
    },
  },
  checkboxCell: {
    width: '48px',
    padding: '8px 16px',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px',
  },
});

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  loading,
  emptyMessage = 'No data available',
  emptyIcon = '📭',
  selectable = false,
  selectedKeys = new Set(),
  onSelectionChange,
  onRowClick,
}: DataTableProps<T>) {
  const styles = useStyles();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const handleSelectAll = () => {
    if (selectedKeys.size === data.length) {
      onSelectionChange?.(new Set());
    } else {
      onSelectionChange?.(new Set(data.map(keyExtractor)));
    }
  };

  const handleSelectRow = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSelection = new Set(selectedKeys);
    if (newSelection.has(key)) {
      newSelection.delete(key);
    } else {
      newSelection.add(key);
    }
    onSelectionChange?.(newSelection);
  };

  if (loading) {
    return (
      <div className={styles.loading}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (data.length === 0) {
    return <EmptyState icon={emptyIcon} title={emptyMessage} />;
  }

  return (
    <div className={styles.wrapper}>
      <Table className={styles.table}>
        <TableHeader>
          <TableRow>
            {selectable && (
              <TableHeaderCell className={mergeClasses(styles.headerCell, styles.checkboxCell)}>
                <Checkbox
                  checked={selectedKeys.size === data.length ? true : selectedKeys.size > 0 ? 'mixed' : false}
                  onChange={handleSelectAll}
                />
              </TableHeaderCell>
            )}
            {columns.map((col) => (
              <TableHeaderCell
                key={col.key}
                style={{ width: col.width }}
                className={mergeClasses(
                  styles.headerCell,
                  col.sortable && styles.sortableHeader
                )}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
              >
                {col.header}
                {col.sortable && sortKey === col.key && (
                  <span className={styles.sortIcon}>
                    {sortDir === 'asc' ? <ArrowUpRegular /> : <ArrowDownRegular />}
                  </span>
                )}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const key = keyExtractor(row);
            const isSelected = selectedKeys.has(key);

            return (
              <TableRow
                key={key}
                className={mergeClasses(
                  styles.row,
                  onRowClick && styles.rowClickable,
                  isSelected && styles.rowSelected
                )}
                onClick={() => onRowClick?.(row)}
              >
                {selectable && (
                  <TableCell
                    className={mergeClasses(styles.cell, styles.checkboxCell)}
                    onClick={(e) => handleSelectRow(key, e)}
                  >
                    <Checkbox checked={isSelected} />
                  </TableCell>
                )}
                {columns.map((col) => (
                  <TableCell key={col.key} className={styles.cell}>
                    {col.render ? col.render(row) : (row as Record<string, unknown>)[col.key] as ReactNode}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
