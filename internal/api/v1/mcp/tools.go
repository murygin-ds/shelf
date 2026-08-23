package mcp

import (
	"context"
	"fmt"
	"time"

	"shelf/internal/mcp"
	"shelf/internal/vault"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// nodeOut is a folder or a note as a tool reports it. Paths are what every other tool takes,
// so a model can move between them without holding an id.
type nodeOut struct {
	Path string   `json:"path"`
	Kind string   `json:"kind"`
	Name string   `json:"name"`
	Icon string   `json:"icon,omitempty"`
	Tags []string `json:"tags,omitempty"`
	// Locked marks a part of the vault sealed with a key the connector was not given. It is
	// listed rather than hidden, so a model can tell "not there" from "not for you".
	Locked bool `json:"locked,omitempty"`
	// ContentSeq is the version a write has to quote back. Notes only.
	ContentSeq int64 `json:"content_seq,omitempty"`
	//nolint:lll // the description is the contract a model reads.
	PendingEdits bool      `json:"pending_edits,omitempty" jsonschema:"The stored body is behind the note's live copy: somebody typed in the editor and the session ended before it was written back. Reading is fine; writing to the note is refused until it has been opened in Shelf again."`
	UpdatedAt    time.Time `json:"updated_at"`
}

// patch turns what was sent into what SetMeta reads: absent means "leave it", and the two
// have to stay distinguishable because the whole field is rewritten either way.
func (in metaInput) patch() mcp.MetaPatch {
	patch := mcp.MetaPatch{}

	if in.Name != "" {
		patch.Name = &in.Name
	}

	if in.Icon != "" {
		patch.Icon = &in.Icon
	}

	if in.Tags != nil {
		patch.Tags = &in.Tags
	}

	return patch
}

func nodeOf(n mcp.Node) nodeOut {
	return nodeOut{
		Path: n.Path, Kind: n.Kind, Name: n.Name, Icon: n.Icon, Tags: n.Tags,
		Locked: n.Locked, ContentSeq: n.ContentSeq, PendingEdits: n.PendingEdits,
		UpdatedAt: n.UpdatedAt,
	}
}

func nodesOf(nodes []mcp.Node) []nodeOut {
	out := make([]nodeOut, 0, len(nodes))
	for _, node := range nodes {
		out = append(out, nodeOf(node))
	}

	return out
}

type (
	listInput struct {
		Path string `json:"path,omitempty" jsonschema:"Folder to list from, as a slash path. Omit for the whole vault."`
	}
	listOutput struct {
		Nodes []nodeOut `json:"nodes"`
	}

	readInput struct {
		Path string `json:"path" jsonschema:"Path of the note, exactly as shelf_list_tree reports it."`
	}
	readOutput struct {
		Note nodeOut `json:"note"`
		Body string  `json:"body"`
	}

	searchInput struct {
		Query string `json:"query,omitempty" jsonschema:"Text to look for in note titles and bodies. Optional when a tag is given."`
		//nolint:lll // the description is the contract a model reads.
		Path  string `json:"path,omitempty" jsonschema:"Restrict the search to this folder and everything under it. Omit to search the whole vault."`
		Tag   string `json:"tag,omitempty"  jsonschema:"Only notes carrying this tag. Combines with query and path."`
		Limit int    `json:"limit,omitempty" jsonschema:"Maximum results, 1 to 50. Defaults to 10."`
	}
	searchOutput struct {
		Hits []hitOut `json:"hits"`
	}
	hitOut struct {
		nodeOut
		Snippet string `json:"snippet"`
	}

	folderInput struct {
		Path string `json:"path" jsonschema:"Folder path to create. Missing parents are created too."`
	}

	// Its own type rather than folderInput: the two calls take the same shape and mean
	// opposite things, and a shared description can only be right about one of them.
	trashFolderInput struct {
		//nolint:lll // the description is the contract a model reads.
		Path string `json:"path" jsonschema:"Path of the folder to move to the trash. It has to be empty — trash what is inside it first."`
	}
	folderOutput struct {
		Folder nodeOut `json:"folder"`
	}

	createInput struct {
		Path string `json:"path" jsonschema:"Path of the new note, including its name. Missing folders are created."`
		Body string `json:"body,omitempty" jsonschema:"Markdown body. Omit for an empty note."`
	}

	writeInput struct {
		Path string `json:"path" jsonschema:"Path of the note to replace."`
		Body string `json:"body" jsonschema:"The complete new body. This replaces the note, it does not merge."`
		//nolint:lll // the description is the contract a model reads.
		ExpectedContentSeq int64 `json:"expected_content_seq" jsonschema:"The content_seq you last read for this note. A mismatch is refused rather than merged: read the note again and reapply your change."`
	}

	appendInput struct {
		Path string `json:"path" jsonschema:"Path of the note to add to."`
		Text string `json:"text" jsonschema:"Markdown to add at the end. A newline is inserted if the note lacks one."`
	}

	writeOutput struct {
		Note nodeOut `json:"note"`
	}

	moveInput struct {
		Path   string `json:"path"   jsonschema:"Path of the note to move."`
		Folder string `json:"folder" jsonschema:"Destination folder. Empty moves the note to the vault root."`
	}

	trashInput struct {
		//nolint:lll // the description is the contract a model reads.
		Path string `json:"path" jsonschema:"Path of the note to move to the trash. Recoverable with shelf_list_trash and shelf_restore."`
	}
	trashOutput struct {
		Trashed string `json:"trashed"`
	}

	metaInput struct {
		Path string `json:"path" jsonschema:"Path of the note or folder to change."`
		Name string `json:"name,omitempty" jsonschema:"New name, one path segment. Omit to leave it. Use shelf_move_note to change the folder."`
		//nolint:lll // the description is the contract a model reads.
		Icon string `json:"icon,omitempty" jsonschema:"One of a fixed set of icon names; anything else is refused with the full list. An empty string removes it, and omitting it leaves it alone."`
		//nolint:lll // the description is the contract a model reads.
		Tags []string `json:"tags,omitempty" jsonschema:"The complete set of tags, replacing whatever is there. Lowercase, letters and digits then also - and _. Send an empty array to clear them; omit to leave them."`
	}

	restoreInput struct {
		ID int64 `json:"id" jsonschema:"The id shelf_list_trash reported for the item."`
	}

	trashedOut struct {
		ID   int64  `json:"id"`
		Kind string `json:"kind"`
		Name string `json:"name"`
		//nolint:lll // the description is the contract a model reads.
		Path      string    `json:"path" jsonschema:"Where it was when it was trashed. Not an address — restore by id."`
		TrashedAt time.Time `json:"trashed_at"`
	}

	trashListOutput struct {
		Items []trashedOut `json:"items"`
	}
)

const (
	defaultSearchLimit = 10
	maxSearchLimit     = 50
)

// register mounts the tools this connector's role allows.
//
// A viewer gets no writing tools at all rather than tools that refuse: a model shown a tool
// will try it, and a refusal it cannot avoid is worse than the tool not being there.
func (t *Transport) register(server *sdk.Server, connector *mcp.Connector) {
	t.readTools(server, connector)

	if connector.Role == vault.RoleEditor {
		t.writeTools(server, connector)
	}
}

func (t *Transport) readTools(server *sdk.Server, connector *mcp.Connector) {
	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_list_tree",
		Description: "List the folders and notes of the connected vault as slash paths. " +
			"Start here: every other tool takes a path this returns.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in listInput) (*sdk.CallToolResult, listOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, listOutput{}, t.logged("shelf_list_tree", connector, err)
		}

		nodes, err := workspace.Tree(ctx, in.Path)
		if err != nil {
			return nil, listOutput{}, t.logged("shelf_list_tree", connector, err)
		}

		return nil, listOutput{Nodes: nodesOf(nodes)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_read_note",
		Description: "Read one note's body. The content_seq it returns is what shelf_write_note " +
			"has to quote back.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in readInput) (*sdk.CallToolResult, readOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, readOutput{}, t.logged("shelf_read_note", connector, err)
		}

		note, err := workspace.ReadNote(ctx, in.Path)
		if err != nil {
			return nil, readOutput{}, t.logged("shelf_read_note", connector, err)
		}

		return nil, readOutput{Note: nodeOf(note.Node), Body: note.Body}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_search_notes",
		Description: "Search note titles and bodies. Narrow it with path to one folder, or with " +
			"tag, or both — either of query and tag is enough on its own. Returns snippets; " +
			"follow up with shelf_read_note for the full text.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in searchInput) (*sdk.CallToolResult, searchOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, searchOutput{}, t.logged("shelf_search_notes", connector, err)
		}

		limit := in.Limit
		if limit <= 0 {
			limit = defaultSearchLimit
		}

		limit = min(limit, maxSearchLimit)

		hits, err := workspace.Search(ctx, mcp.Query{Text: in.Query, Under: in.Path, Tag: in.Tag}, limit)
		if err != nil {
			return nil, searchOutput{}, t.logged("shelf_search_notes", connector, err)
		}

		out := searchOutput{Hits: make([]hitOut, 0, len(hits))}
		for _, hit := range hits {
			out.Hits = append(out.Hits, hitOut{nodeOut: nodeOf(hit.Node), Snippet: hit.Snippet})
		}

		return nil, out, nil
	})
}

func (t *Transport) writeTools(server *sdk.Server, connector *mcp.Connector) {
	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_create_folder",
		Description: "Create a folder, and any folder above it that does not exist yet.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in folderInput) (*sdk.CallToolResult, folderOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, folderOutput{}, t.logged("shelf_create_folder", connector, err)
		}

		folder, err := workspace.CreateFolder(ctx, in.Path)
		if err != nil {
			return nil, folderOutput{}, t.logged("shelf_create_folder", connector, err)
		}

		return nil, folderOutput{Folder: nodeOf(*folder)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_create_note",
		Description: fmt.Sprintf(
			"Create a note, with its folders if they are missing. Bodies are markdown, up to %d bytes.",
			mcp.MaxBodyBytes),
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in createInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_create_note", connector, err)
		}

		note, err := workspace.CreateNote(ctx, in.Path, in.Body)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_create_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(note.Node)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_write_note",
		Description: "Replace a note's body. Quote back the content_seq you read: if somebody " +
			"changed the note since, the write is refused rather than overwriting them.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in writeInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_write_note", connector, err)
		}

		note, err := workspace.WriteNote(ctx, in.Path, in.Body, in.ExpectedContentSeq)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_write_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(note.Node)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_append_note",
		Description: "Add to the end of a note. Reads and writes in one step, so no version is needed.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in appendInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_append_note", connector, err)
		}

		note, err := workspace.AppendNote(ctx, in.Path, in.Text)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_append_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(note.Node)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_move_note",
		Description: "Move a note to another folder, creating the folder if it is missing.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in moveInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_move_note", connector, err)
		}

		note, err := workspace.MoveNote(ctx, in.Path, in.Folder)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_move_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(*note)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_set_meta",
		Description: "Rename a note or folder, or set a note's icon and tags. Everything left " +
			"out is kept: these share one encrypted field, so this replaces all of it at once.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in metaInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_set_meta", connector, err)
		}

		node, err := workspace.SetMeta(ctx, in.Path, in.patch())
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_set_meta", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(*node)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_trash_folder",
		Description: "Move an empty folder to the trash. Trash its notes first: a folder taken " +
			"with its contents would remove a whole project by naming one directory.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in trashFolderInput) (*sdk.CallToolResult, trashOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, trashOutput{}, t.logged("shelf_trash_folder", connector, err)
		}

		if err := workspace.TrashFolder(ctx, in.Path); err != nil {
			return nil, trashOutput{}, t.logged("shelf_trash_folder", connector, err)
		}

		return nil, trashOutput{Trashed: in.Path}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_list_trash",
		Description: "List what is in the trash, with the id each item is restored by. Trashed " +
			"items are addressed by id, not path: the place a note came from may hold another now.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, _ struct{}) (*sdk.CallToolResult, trashListOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, trashListOutput{}, t.logged("shelf_list_trash", connector, err)
		}

		binned, err := workspace.Trash(ctx)
		if err != nil {
			return nil, trashListOutput{}, t.logged("shelf_list_trash", connector, err)
		}

		out := trashListOutput{Items: make([]trashedOut, 0, len(binned))}
		for _, item := range binned {
			out.Items = append(out.Items, trashedOut{
				ID: item.ID, Kind: item.Kind, Name: item.Name,
				Path: item.Path, TrashedAt: item.TrashedAt,
			})
		}

		return nil, out, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_restore",
		Description: "Take a note or folder out of the trash, using an id from shelf_list_trash. " +
			"Restoring a folder brings back everything that was inside it, so its notes leave " +
			"the trash at the same time and their own ids stop being restorable.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in restoreInput) (*sdk.CallToolResult, trashedOut, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, trashedOut{}, t.logged("shelf_restore", connector, err)
		}

		item, err := workspace.Restore(ctx, in.ID)
		if err != nil {
			return nil, trashedOut{}, t.logged("shelf_restore", connector, err)
		}

		return nil, trashedOut{
			ID: item.ID, Kind: item.Kind, Name: item.Name,
			Path: item.Path, TrashedAt: item.TrashedAt,
		}, nil
	})

	// Trash only. Purging destroys ciphertext nothing brings back, which is not a decision
	// to put behind a tool call.
	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_trash_note",
		Description: "Move a note to the trash, where a person can restore it. Nothing here deletes for good.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in trashInput) (*sdk.CallToolResult, trashOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, trashOutput{}, t.logged("shelf_trash_note", connector, err)
		}

		if err := workspace.TrashNote(ctx, in.Path); err != nil {
			return nil, trashOutput{}, t.logged("shelf_trash_note", connector, err)
		}

		return nil, trashOutput{Trashed: in.Path}, nil
	})
}
