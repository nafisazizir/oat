import type {
  CreateDocumentInput,
  UpdateDocumentInput,
  MoveDocumentInput,
  DocumentListQuery,
  DocumentSummary,
  DocumentDetail,
  DocumentSharing,
  UpdateSharingInput,
  CreateFolderInput,
  RenameFolderInput,
  MoveFolderInput,
  FolderSummary,
  DeleteFolderResult,
  NotionConnectionInfo,
  NotionTargetOption,
  SetNotionTargetInput,
  NotionDocumentStatus,
  NotionPushInput,
  NotionPushResult,
} from '@oat/services/dto/api-types';
import type {
  MeetingInfo,
  MeetingParticipant,
  AddParticipantInput,
  MeetingQuery,
} from '@oat/services/dto/meeting';
import type {
  EnhancementDto,
  StartEnhanceInput,
  StartEnhanceResult,
  EnhancementVersionList,
  EnhancementDetail,
  RestoreEnhancementInput,
  RestoreEnhancementResult,
} from '@oat/services/dto/enhance';
import type {
  CreateTemplateInput,
  DuplicateTemplateInput,
  UpdateTemplateInput,
  TemplateList,
  TemplateDetail,
} from '@oat/services/dto/templates';
import type {
  TaskListQuery,
  TaskListResponse,
  UpdateTaskInput,
  UpdateTaskResult,
  TaskAssigneesQuery,
  TaskAssigneesResponse,
} from '@oat/services/dto/tasks';
import type {
  ChatSendInput,
  ChatThreadsQuery,
  ChatThreadList,
  ChatThreadDetail,
  ProposalDecisionInput,
  ProposalDecisionResult,
} from '@oat/services/dto/chat';
import type { SearchQuery, SearchResponse } from '@oat/services/dto/search';
import type { ProfileDto, ProfileInput } from '@oat/services/dto/profile';
import type {
  PipelineRunResponse,
  PipelineSettingsDto,
  UpdatePipelineSettingsInput,
} from '@oat/services/dto/pipeline';
import type {
  UpcomingQuery,
  UpcomingMeetingsDto,
  StartNotesInput,
  StartNotesResult,
} from '@oat/services/dto/calendar';
import type {
  WorkspaceList,
  WorkspaceSettings,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  DeleteWorkspaceInput,
  InviteMemberInput,
  MemberRoleInput,
  JoinPolicyInput,
  RemoveDomainInput,
  MutationResult,
  WorkspaceMutationResult,
  JoinChoices,
  MemberView,
  InviteView,
  JoinRequestView,
  CalendarConnectionStatus,
} from '@oat/services/dto/workspaces';

import {
  type OatRequest,
  type OatTransport,
  OatApiError,
  assertApiPath,
  transportRequest,
  checkResponse,
  asFetchResponse,
} from './transport.ts';

export type RequestOptions = { signal?: AbortSignal };
type Payload = RequestOptions & {
  params?: Record<string, string>;
  body?: unknown;
  query?: OatRequest['query'];
};
type Mode = 'json' | 'response' | 'stream';

export function createOatClient(transport: OatTransport) {
  function endpoint<Result>(mode: Mode = 'json') {
    return <Args extends unknown[]>(
      method: OatRequest['method'],
      path: string,
      input: (...args: Args) => Payload,
    ) =>
      Object.assign(
        async (...args: Args): Promise<Result> => {
          const { params, ...payload } = input(...args);
          const resolved = path.replace(/\[([^\]]+)\]/g, (_, key: string) => {
            const value = params?.[key];
            if (!value || value === '.' || value === '..')
              throw new TypeError('Missing or invalid route parameter: ' + key);
            return encodeURIComponent(value);
          });
          assertApiPath(resolved);
          const response = await transportRequest(transport, {
            method,
            path: resolved,
            ...payload,
            ...(mode !== 'json' ? { stream: true } : {}),
          });
          await checkResponse(response);
          if (response.status === 204) return undefined as Result;
          if (mode === 'response') return (await asFetchResponse(response)) as Result;
          if (mode === 'stream') {
            if (!response.body)
              throw new OatApiError(response.status, 'missing_stream', 'Oat returned no stream.');
            return response.body as Result;
          }
          return (await response.json()) as Result;
        },
        { endpoint: { method, path } },
      );
  }

  const byId = (id: string, options: RequestOptions = {}): Payload => ({
    params: { id },
    ...options,
  });
  const withBody = <Body>(id: string, body: Body, options: RequestOptions = {}): Payload => ({
    params: { id },
    body,
    ...options,
  });
  const noInput = (options: RequestOptions = {}): Payload => options;
  const bodyInput = <Body>(body: Body, options: RequestOptions = {}): Payload => ({
    body,
    ...options,
  });
  const workspaceQuery = (workspaceId: string, options: RequestOptions = {}): Payload => ({
    query: { workspaceId },
    ...options,
  });
  const queryInput = <Query extends NonNullable<OatRequest['query']>>(
    query: Query,
    options: RequestOptions = {},
  ): Payload => ({ query, ...options });

  return {
    documents: {
      list: endpoint<DocumentSummary[]>()('GET', '/api/documents', queryInput<DocumentListQuery>),
      get: endpoint<DocumentDetail>()('GET', '/api/documents/[id]', byId),
      create: endpoint<DocumentDetail>()('POST', '/api/documents', bodyInput<CreateDocumentInput>),
      update: endpoint<DocumentDetail>()(
        'PATCH',
        '/api/documents/[id]',
        withBody<UpdateDocumentInput>,
      ),
      delete: endpoint<DocumentDetail>()('DELETE', '/api/documents/[id]', byId),
      deleteForever: endpoint<void>()(
        'DELETE',
        '/api/documents/[id]',
        (id: string, options: RequestOptions = {}) => ({
          ...byId(id, options),
          query: { permanent: true },
        }),
      ),
      restore: endpoint<DocumentDetail>()('POST', '/api/documents/[id]/restore', byId),
      move: endpoint<DocumentDetail>()(
        'POST',
        '/api/documents/[id]/move',
        withBody<MoveDocumentInput>,
      ),
      sharing: endpoint<DocumentSharing>()('GET', '/api/documents/[id]/share', byId),
      updateSharing: endpoint<DocumentSharing>()(
        'PATCH',
        '/api/documents/[id]/share',
        withBody<UpdateSharingInput>,
      ),
      meeting: endpoint<MeetingInfo>()(
        'GET',
        '/api/documents/[id]/meeting',
        (id: string, query: MeetingQuery = {}, options: RequestOptions = {}) => ({
          ...byId(id, options),
          query: {
            ...query,
            transcript: query.transcript ? '1' : undefined,
            recording: query.recording ? '1' : undefined,
          },
        }),
      ),
      addParticipant: endpoint<MeetingParticipant>()(
        'POST',
        '/api/documents/[id]/participants',
        withBody<AddParticipantInput>,
      ),
      removeParticipant: endpoint<void>()(
        'DELETE',
        '/api/documents/[id]/participants/[participantId]',
        (id: string, participantId: string, options: RequestOptions = {}) => ({
          params: { id, participantId },
          ...options,
        }),
      ),
      pipeline: endpoint<PipelineRunResponse>()('GET', '/api/documents/[id]/pipeline', byId),
      runPipeline: endpoint<PipelineRunResponse>()('POST', '/api/documents/[id]/pipeline', byId),
      notion: endpoint<NotionDocumentStatus>()('GET', '/api/documents/[id]/notion', byId),
      pushToNotion: endpoint<NotionPushResult>()(
        'POST',
        '/api/documents/[id]/notion',
        (id: string, body: NotionPushInput = {}, options: RequestOptions = {}) =>
          withBody(id, body, options),
      ),
    },
    folders: {
      tree: endpoint<FolderSummary[]>()('GET', '/api/folders', workspaceQuery),
      create: endpoint<FolderSummary>()('POST', '/api/folders', bodyInput<CreateFolderInput>),
      update: endpoint<FolderSummary>()('PATCH', '/api/folders/[id]', withBody<RenameFolderInput>),
      move: endpoint<FolderSummary>()('POST', '/api/folders/[id]/move', withBody<MoveFolderInput>),
      delete: endpoint<DeleteFolderResult>()('DELETE', '/api/folders/[id]', byId),
    },
    enhancements: {
      enhance: endpoint<StartEnhanceResult>()(
        'POST',
        '/api/documents/[id]/enhance',
        withBody<StartEnhanceInput>,
      ),
      latest: endpoint<{ latest: EnhancementDto | null }>()(
        'GET',
        '/api/documents/[id]/enhance',
        byId,
      ),
      list: endpoint<EnhancementVersionList>()('GET', '/api/documents/[id]/enhancements', byId),
      get: endpoint<EnhancementDetail>()('GET', '/api/enhancements/[id]', byId),
      restore: endpoint<RestoreEnhancementResult>()(
        'POST',
        '/api/enhancements/[id]/restore',
        withBody<RestoreEnhancementInput>,
      ),
      stream: endpoint<ReadableStream<Uint8Array>>('stream')(
        'GET',
        '/api/enhancements/[id]/stream',
        (id: string, query: { lastEventId?: string } = {}, options: RequestOptions = {}) => ({
          ...byId(id, options),
          query,
        }),
      ),
    },
    templates: {
      list: endpoint<TemplateList>()('GET', '/api/templates', workspaceQuery),
      get: endpoint<TemplateDetail>()(
        'GET',
        '/api/templates/[id]',
        (id: string, workspaceId?: string, options: RequestOptions = {}) => ({
          ...byId(id, options),
          query: { workspaceId },
        }),
      ),
      create: endpoint<TemplateDetail>()('POST', '/api/templates', bodyInput<CreateTemplateInput>),
      duplicate: endpoint<TemplateDetail>()(
        'POST',
        '/api/templates',
        bodyInput<DuplicateTemplateInput>,
      ),
      update: endpoint<TemplateDetail>()(
        'PATCH',
        '/api/templates/[id]',
        withBody<UpdateTemplateInput>,
      ),
      delete: endpoint<void>()('DELETE', '/api/templates/[id]', byId),
    },
    tasks: {
      list: endpoint<TaskListResponse>()(
        'GET',
        '/api/tasks',
        (query: TaskListQuery = {}, options: RequestOptions = {}) => queryInput(query, options),
      ),
      update: endpoint<UpdateTaskResult>()('PATCH', '/api/tasks/[id]', withBody<UpdateTaskInput>),
      assignees: endpoint<TaskAssigneesResponse>()(
        'GET',
        '/api/tasks/assignees',
        queryInput<TaskAssigneesQuery>,
      ),
    },
    chat: {
      send: endpoint<Response>('response')('POST', '/api/chat', bodyInput<ChatSendInput>),
      threads: endpoint<ChatThreadList>()('GET', '/api/chat/threads', queryInput<ChatThreadsQuery>),
      thread: endpoint<ChatThreadDetail>()('GET', '/api/chat/threads/[id]', byId),
      decideProposal: endpoint<ProposalDecisionResult>()(
        'POST',
        '/api/chat/threads/[id]/proposals/[proposalId]',
        (
          id: string,
          proposalId: string,
          body: ProposalDecisionInput,
          options: RequestOptions = {},
        ) => ({
          params: { id, proposalId },
          body,
          ...options,
        }),
      ),
    },
    search: endpoint<SearchResponse>()('GET', '/api/search', queryInput<SearchQuery>),
    profile: {
      get: endpoint<ProfileDto>()('GET', '/api/profile', noInput),
      update: endpoint<ProfileDto>()('PUT', '/api/profile', bodyInput<ProfileInput>),
    },
    pipeline: {
      settings: endpoint<PipelineSettingsDto>()('GET', '/api/settings/pipeline', workspaceQuery),
      updateSettings: endpoint<PipelineSettingsDto>()(
        'PUT',
        '/api/settings/pipeline',
        bodyInput<UpdatePipelineSettingsInput>,
      ),
    },
    notion: {
      status: endpoint<NotionConnectionInfo | null>()(
        'GET',
        '/api/integrations/notion',
        workspaceQuery,
      ),
      targets: endpoint<NotionTargetOption[]>()(
        'GET',
        '/api/integrations/notion/targets',
        (workspaceId: string, q?: string, options: RequestOptions = {}) => ({
          ...workspaceQuery(workspaceId, options),
          query: { workspaceId, q },
        }),
      ),
      target: endpoint<NotionConnectionInfo>()(
        'PUT',
        '/api/integrations/notion/target',
        bodyInput<SetNotionTargetInput>,
      ),
      disconnect: endpoint<void>()('DELETE', '/api/integrations/notion', workspaceQuery),
      connectUrl: () => '/api/integrations/notion/connect' as const,
    },
    calendar: {
      upcoming: endpoint<UpcomingMeetingsDto>()(
        'GET',
        '/api/calendar/upcoming',
        (query: UpcomingQuery = {}, options: RequestOptions = {}) => queryInput(query, options),
      ),
      notes: endpoint<StartNotesResult>()(
        'POST',
        '/api/calendar/notes',
        bodyInput<StartNotesInput>,
      ),
      google: {
        status: endpoint<CalendarConnectionStatus>()('GET', '/api/calendar/google', noInput),
        disconnect: endpoint<MutationResult>()('DELETE', '/api/calendar/google', noInput),
      },
    },
    workspaces: {
      list: endpoint<WorkspaceList>()('GET', '/api/workspaces', noInput),
      create: endpoint<WorkspaceMutationResult>()(
        'POST',
        '/api/workspaces',
        bodyInput<CreateWorkspaceInput>,
      ),
      switchActive: endpoint<WorkspaceMutationResult>()(
        'PUT',
        '/api/workspaces/active',
        (workspaceId: string, options: RequestOptions = {}) => bodyInput({ workspaceId }, options),
      ),
      get: endpoint<WorkspaceSettings>()('GET', '/api/workspaces/[id]', byId),
      update: endpoint<MutationResult>()(
        'PATCH',
        '/api/workspaces/[id]',
        withBody<UpdateWorkspaceInput>,
      ),
      delete: endpoint<MutationResult>()(
        'DELETE',
        '/api/workspaces/[id]',
        withBody<DeleteWorkspaceInput>,
      ),
      leave: endpoint<MutationResult>()('POST', '/api/workspaces/[id]/leave', byId),
      members: endpoint<MemberView[]>()('GET', '/api/workspaces/[id]/members', byId),
      updateMember: endpoint<MutationResult>()(
        'PATCH',
        '/api/workspaces/[id]/members/[memberId]',
        (id: string, memberId: string, body: MemberRoleInput, options: RequestOptions = {}) => ({
          params: { id, memberId },
          body,
          ...options,
        }),
      ),
      removeMember: endpoint<MutationResult>()(
        'DELETE',
        '/api/workspaces/[id]/members/[memberId]',
        (id: string, memberId: string, options: RequestOptions = {}) => ({
          params: { id, memberId },
          ...options,
        }),
      ),
      invites: endpoint<InviteView[]>()('GET', '/api/workspaces/[id]/invites', byId),
      invite: endpoint<MutationResult>()(
        'POST',
        '/api/workspaces/[id]/invites',
        withBody<InviteMemberInput>,
      ),
      resendInvite: endpoint<MutationResult>()(
        'POST',
        '/api/workspaces/[id]/invites/[inviteId]/resend',
        (id: string, inviteId: string, options: RequestOptions = {}) => ({
          params: { id, inviteId },
          ...options,
        }),
      ),
      revokeInvite: endpoint<MutationResult>()(
        'DELETE',
        '/api/workspaces/[id]/invites/[inviteId]',
        (id: string, inviteId: string, options: RequestOptions = {}) => ({
          params: { id, inviteId },
          ...options,
        }),
      ),
      setJoinPolicy: endpoint<MutationResult>()(
        'PUT',
        '/api/workspaces/[id]/join-policy',
        withBody<JoinPolicyInput>,
      ),
      allowMyDomain: endpoint<MutationResult>()('POST', '/api/workspaces/[id]/domains', byId),
      removeDomain: endpoint<MutationResult>()(
        'DELETE',
        '/api/workspaces/[id]/domains',
        withBody<RemoveDomainInput>,
      ),
      joinRequests: endpoint<JoinRequestView[]>()(
        'GET',
        '/api/workspaces/[id]/join-requests',
        byId,
      ),
      approveJoinRequest: endpoint<MutationResult>()(
        'POST',
        '/api/workspaces/[id]/join-requests/[requestId]/approve',
        (id: string, requestId: string, body: MemberRoleInput, options: RequestOptions = {}) => ({
          params: { id, requestId },
          body,
          ...options,
        }),
      ),
      declineJoinRequest: endpoint<MutationResult>()(
        'POST',
        '/api/workspaces/[id]/join-requests/[requestId]/decline',
        (id: string, requestId: string, options: RequestOptions = {}) => ({
          params: { id, requestId },
          ...options,
        }),
      ),
      join: endpoint<MutationResult>()('POST', '/api/workspaces/[id]/join', byId),
      requestAccess: endpoint<MutationResult>()(
        'POST',
        '/api/workspaces/[id]/request-access',
        byId,
      ),
      createMy: endpoint<MutationResult>()('POST', '/api/workspaces/mine', noInput),
      joinable: endpoint<JoinChoices>()('GET', '/api/workspaces/joinable', noInput),
      export: endpoint<Response>('response')('GET', '/api/workspaces/[id]/export', byId),
    },
    invites: {
      accept: endpoint<MutationResult>()(
        'POST',
        '/api/invites/accept',
        (token: string, options: RequestOptions = {}) => bodyInput({ token }, options),
      ),
      decline: endpoint<MutationResult>()(
        'POST',
        '/api/invites/decline',
        (token: string, options: RequestOptions = {}) => bodyInput({ token }, options),
      ),
    },
  };
}

export type OatClient = ReturnType<typeof createOatClient>;
