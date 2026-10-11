"""The outcome classifier of grounding_report.py: the one piece of logic in the eval tools."""

from grounding_report import classify


def test_an_answer_with_no_marks_is_clean() -> None:
    assert classify("Revenue was higher and the stock rose.") == ("clean", 0, 0)


def test_unverified_marks_in_both_scripts_are_counted_as_flagged() -> None:
    assert classify("US$331.53 (unverified※) and 1.00 元（未核验※）") == ("FLAGGED", 2, 0)


def test_a_footnote_that_explains_the_mark_does_not_count_as_another_figure() -> None:
    answer = (
        "US$331.53 (unverified※).\n\n"
        "※ 1 figure(s) could not be matched and are marked (unverified※)."
    )
    assert classify(answer) == ("FLAGGED", 1, 0)


def test_omitted_marks_in_both_scripts_are_counted_as_cut() -> None:
    assert classify("target (omitted※) and 目标价（略※）") == ("CUT", 0, 2)


def test_a_flagged_answer_that_also_cut_a_figure_is_reported_as_flagged() -> None:
    assert classify("a (unverified※) b (omitted※)") == ("FLAGGED", 1, 1)


def test_the_canned_refusal_is_a_stub_whatever_else_it_says() -> None:
    assert classify("I rejected the previous draft because its prices conflicted with tool evidence.")[0] == "STUB"
    assert classify("My answer did not pass the figure check: some figures could not be matched.")[0] == "STUB"
