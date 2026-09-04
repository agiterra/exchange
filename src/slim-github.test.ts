import { describe, expect, test } from "bun:test";
import { slimGithubPayload } from "./server";
describe("slimGithubPayload", () => {
  test("drops changes/organization/installation, slims repository/sender/user, keeps what lanes read", () => {
    const body = { action: "edited", changes: { body: { from: "x".repeat(20000) } }, organization: { login: "o", big: "y".repeat(5000) }, installation: { id: 1 },
      repository: { id: 1, name: "soil-app", full_name: "fabrica-land/soil-app", default_branch: "main", html_url: "h", private: true, owner: { login: "fabrica-land", avatar_url: "z".repeat(3000) }, description: "d" },
      sender: { login: "coderabbitai[bot]", type: "Bot", id: 5, avatar_url: "a".repeat(3000) },
      issue: { number: 1355, title: "t", user: { login: "u", avatar_url: "b".repeat(3000) }, reactions: { "+1": 0 }, labels: [{ name: "bug", color: "f" }], pull_request: { url: "p" } },
      comment: { id: 9, body: "the comment", user: { login: "coderabbitai[bot]", type: "Bot", avatar_url: "c".repeat(3000) }, reactions: {}, performed_via_github_app: { slug: "x" } } };
    const out = slimGithubPayload(body) as any;
    expect(out.changes).toBeUndefined(); expect(out.organization).toBeUndefined(); expect(out.installation).toBeUndefined();
    expect(out.repository).toEqual({ id: 1, name: "soil-app", full_name: "fabrica-land/soil-app", default_branch: "main", html_url: "h", private: true });
    expect(out.sender).toEqual({ login: "coderabbitai[bot]", type: "Bot", id: 5 });
    expect(out.issue.number).toBe(1355); expect(out.issue.labels).toEqual(["bug"]); expect(out.issue.user).toEqual({ login: "u" }); expect(out.issue.reactions).toBeUndefined();
    expect(out.comment.body).toBe("the comment"); expect(out.comment.performed_via_github_app).toBeUndefined();
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(body).length / 10);
    expect(slimGithubPayload("not json")).toBe("not json"); expect(slimGithubPayload(null)).toBe(null);
  });
  test("pull_request body capped, diff hunks and *_url scaffolding dropped, comment body kept whole", () => {
    const body = { action: "edited", pull_request: { number: 1847, body: "B".repeat(9000), title: "t", html_url: "h", url: "u", statuses_url: "s", comments_url: "c", head: { ref: "r", sha: "x", repo: {} }, base: { ref: "main", sha: "y" }, mergeable_state: "clean", draft: false },
      comment: { id: 1, body: "review text ".repeat(50), diff_hunk: "@@ -1 +1 @@\n" + "d".repeat(3000), path: "a.ts", html_url: "h", url: "u", pull_request_url: "p" }, sender: { login: "coderabbitai[bot]", type: "Bot" } };
    const out = slimGithubPayload(body) as any;
    expect(out.pull_request.body.length).toBeLessThan(600); expect(out.pull_request.body).toContain("trimmed by the Wire gateway");
    expect(out.pull_request.number).toBe(1847); expect(out.pull_request.head).toEqual({ ref: "r", sha: "x" }); expect(out.pull_request.mergeable_state).toBe("clean");
    expect(out.pull_request.statuses_url).toBeUndefined(); expect(out.pull_request.url).toBeUndefined(); expect(out.pull_request.html_url).toBe("h");
    expect(out.comment.body).toBe("review text ".repeat(50)); expect(out.comment.diff_hunk).toBeUndefined(); expect(out.comment.path).toBe("a.ts");
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(body).length / 8);
  });
});
