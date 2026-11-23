export const NEW_WORKSPACE_CHAT_EVENT = 'oat:new-workspace-chat';

export function requestNewWorkspaceChat(workspaceId: string) {
  window.dispatchEvent(new CustomEvent(NEW_WORKSPACE_CHAT_EVENT, { detail: { workspaceId } }));
}
