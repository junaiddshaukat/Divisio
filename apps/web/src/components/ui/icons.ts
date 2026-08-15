/**
 * The icon vocabulary.
 *
 * One name per concept, resolved in one place. Components import from here
 * rather than reaching into lucide directly, so the same idea cannot end up
 * drawn two different ways in two different panes — which is most of what makes
 * an interface feel assembled rather than designed.
 *
 * Sizing and stroke come from foundation.css via the `.lucide` class, so call
 * sites never pass size props.
 */

export {
  // Navigation and structure
  PanelLeft as SidebarIcon,
  LayoutGrid as BoardIcon,
  Folder as ProjectIcon,
  FolderOpen as ProjectOpenIcon,
  MessageSquare as ThreadIcon,
  Plus as NewIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  X as CloseIcon,
  Menu as MenuIcon,
  Search as SearchIcon,

  // Files and code
  File as FileIcon,
  FileCode as FileCodeIcon,
  Save as SaveIcon,
  Copy as CopyIcon,
  Check as CheckIcon,

  // Agent and session state
  Bot as AgentIcon,
  Sparkles as ModelIcon,
  ArrowUp as SendIcon,
  Square as StopIcon,
  Loader as LoadingIcon,
  CircleAlert as ErrorIcon,
  ShieldQuestion as ApprovalIcon,
  ArrowRightLeft as HandoffIcon,

  // Git and delivery
  GitBranch as BranchIcon,
  GitCommit as CommitIcon,
  GitPullRequest as PullRequestIcon,
  FileDiff as DiffIcon,
  History as RestoreIcon,
  RefreshCw as RefreshIcon,
  Upload as PushIcon,

  // Workspace surfaces
  Terminal as TerminalIcon,
  Columns2 as LaneIcon,
  Archive as ArchiveIcon,
  Globe as BrowserIcon,
  Paperclip as AttachIcon,
  Lock as LockIcon,
  FolderOpen as FinderIcon,
  Box as OpenInIcon,

  // System
  Settings as SettingsIcon,
  MonitorSmartphone as DevicesIcon,
  Cpu as ProviderIcon,
  Trash2 as DeleteIcon,
  ExternalLink as ExternalIcon,
  Palette as AppearanceIcon,
  Keyboard as KeybindingsIcon,
  Unplug as ConnectionsIcon,
  CircleUser as ProfileIcon,
  Link as LinkIcon,
  SquarePen as NewThreadIcon,
  PanelLeftClose as SidebarHideIcon,
  PanelLeft as SidebarShowIcon,
  LockOpen as UnlockIcon,
  Pencil as EditIcon,
  Camera as CameraIcon,
  FolderPlus as AddProjectIcon,
  ChartNoAxesColumn as UsageIcon,
} from "lucide-react";
