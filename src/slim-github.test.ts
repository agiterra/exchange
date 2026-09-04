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
});
