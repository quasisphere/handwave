/--
%%handwave
id: algebra.nat.add_assoc
prose.short:
  Addition of natural numbers is associative.
prose.long:
  When adding three natural numbers, the placement of parentheses does not
  change the final result.
proof.sketch:
  This follows from the standard associativity theorem for natural addition.
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c
